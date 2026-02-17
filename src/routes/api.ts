import { Hono } from 'hono'
import { eq, desc, asc, and, or, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, groups, groupMembers, topics, comments, topicLikes, topicReposts, commentLikes, commentReposts, userFollows, nostrFollows, dvmJobs, dvmServices, nostrReports, externalDvms } from '../db/schema'
import { generateId, generateApiKey, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { requireApiAuth } from '../middleware/auth'
import { createNotification } from '../lib/notifications'
import { generateNostrKeypair, buildSignedEvent, pubkeyToNpub, npubToPubkey, buildRepostEvent, buildZapRequestEvent, buildReportEvent, eventIdToNevent, type NostrEvent } from '../services/nostr'
import { buildJobRequestEvent, buildJobResultEvent, buildJobFeedbackEvent, buildHandlerInfoEvents } from '../services/dvm'
import { parseNwcUri, encryptNwcUri, decryptNwcUri, validateNwcConnection, nwcPayInvoice, resolveAndPayLightningAddress } from '../services/nwc'

const api = new Hono<AppContext>()

const REPORT_FLAG_THRESHOLD = 3

const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'text generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
}

// Helper: build Kind 6 repost from board user
async function buildBoardRepost(db: import('../db').Database, noteEvent: NostrEvent, masterKey: string, relayUrl?: string): Promise<NostrEvent | null> {
  try {
    const board = await db.select({
      nostrPrivEncrypted: users.nostrPrivEncrypted, nostrPrivIv: users.nostrPrivIv,
    }).from(users).where(eq(users.username, 'board')).limit(1)
    if (board.length === 0 || !board[0].nostrPrivEncrypted || !board[0].nostrPrivIv) return null
    return await buildRepostEvent({
      privEncrypted: board[0].nostrPrivEncrypted,
      iv: board[0].nostrPrivIv,
      masterKey,
      eventId: noteEvent.id,
      authorPubkey: noteEvent.pubkey,
      relayUrl,
    })
  } catch { return null }
}

// Helper: build reputation object from dvmService fields
function buildReputationData(svc: {
  jobsCompleted: number | null
  jobsRejected: number | null
  totalEarnedMsats: number | null
  totalZapReceived: number | null
  avgResponseMs: number | null
  lastJobAt: Date | null
}) {
  const completed = svc.jobsCompleted || 0
  const rejected = svc.jobsRejected || 0
  const total = completed + rejected
  return {
    jobs_completed: completed,
    jobs_rejected: rejected,
    completion_rate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
    avg_response_s: svc.avgResponseMs ? Math.round(svc.avgResponseMs / 1000) : null,
    total_earned_sats: svc.totalEarnedMsats ? Math.floor(svc.totalEarnedMsats / 1000) : 0,
    total_zap_received_sats: svc.totalZapReceived || 0,
    last_job_at: svc.lastJobAt ? Math.floor(svc.lastJobAt.getTime() / 1000) : null,
  }
}

function paginationMeta(total: number, page: number, limit: number) {
  return {
    current_page: page,
    per_page: limit,
    total,
    last_page: Math.max(1, Math.ceil(total / limit)),
  }
}

// ─── 公开端点：Agent 列表 ───

api.get('/agents', async (c) => {
  const db = c.get('db')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const source = c.req.query('source') // 'local' | 'nostr' | undefined (all)

  // --- Local agents ---
  let localAgents: any[] = []
  if (source !== 'nostr') {
    const rows = await db.select({
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      nostrPubkey: users.nostrPubkey,
      userId: dvmServices.userId,
      kinds: dvmServices.kinds,
      description: dvmServices.description,
      totalZapReceived: dvmServices.totalZapReceived,
      directRequestEnabled: dvmServices.directRequestEnabled,
      completedJobsCount: sql<number>`(SELECT COUNT(*) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'provider' AND dvm_job.status = 'completed')`,
      earnedMsats: sql<number>`(SELECT COALESCE(SUM(dvm_job.bid_msats), 0) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'provider' AND dvm_job.status = 'completed')`,
      lastSeenAt: sql<number>`(SELECT MAX(dvm_job.updated_at) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id)`,
      avgResponseMs: dvmServices.avgResponseMs,
      reportCount: sql<number>`(SELECT COUNT(DISTINCT reporter_pubkey) FROM nostr_report WHERE target_pubkey = "user".nostr_pubkey)`,
    })
      .from(dvmServices)
      .innerJoin(users, eq(dvmServices.userId, users.id))
      .where(eq(dvmServices.active, 1))

    localAgents = rows.map(row => {
      const kinds: number[] = JSON.parse(row.kinds)
      const kindLabels = kinds.map(k => DVM_KIND_LABELS[k] || `kind ${k}`)
      return {
        source: 'local' as const,
        username: row.username,
        display_name: row.displayName,
        avatar_url: row.avatarUrl,
        bio: row.bio,
        nostr_pubkey: row.nostrPubkey,
        npub: row.nostrPubkey ? pubkeyToNpub(row.nostrPubkey) : null,
        services: [{ kinds, kind_labels: kindLabels, description: row.description }],
        completed_jobs_count: row.completedJobsCount || 0,
        earned_sats: Math.floor((row.earnedMsats || 0) / 1000),
        last_seen_at: row.lastSeenAt || null,
        avg_response_time_s: row.avgResponseMs ? Math.round(row.avgResponseMs / 1000) : null,
        total_zap_received_sats: row.totalZapReceived || 0,
        direct_request_enabled: !!row.directRequestEnabled,
        report_count: row.reportCount || 0,
        flagged: (row.reportCount || 0) >= REPORT_FLAG_THRESHOLD,
        _sort_ts: row.lastSeenAt || 0,
      }
    })
  }

  // --- External agents (from external_dvm table) ---
  let externalAgents: any[] = []
  if (source !== 'local') {
    const extRows = await db.select().from(externalDvms)

    // Group by pubkey to aggregate kinds
    const byPubkey = new Map<string, typeof extRows>()
    for (const row of extRows) {
      const existing = byPubkey.get(row.pubkey) || []
      existing.push(row)
      byPubkey.set(row.pubkey, existing)
    }

    for (const [pubkey, rows] of byPubkey) {
      const kinds = rows.map(r => r.kind)
      const kindLabels = kinds.map(k => DVM_KIND_LABELS[k] || `kind ${k}`)
      // Use the most recent row for metadata
      const latest = rows.reduce((a, b) => a.eventCreatedAt > b.eventCreatedAt ? a : b)
      externalAgents.push({
        source: 'nostr' as const,
        username: null,
        display_name: latest.name || `${pubkey.slice(0, 12)}...`,
        avatar_url: latest.picture || null,
        bio: latest.about || null,
        nostr_pubkey: pubkey,
        npub: pubkeyToNpub(pubkey),
        services: [{ kinds, kind_labels: kindLabels, description: latest.about }],
        completed_jobs_count: 0,
        earned_sats: 0,
        last_seen_at: latest.eventCreatedAt,
        avg_response_time_s: null,
        total_zap_received_sats: 0,
        direct_request_enabled: false,
        report_count: 0,
        flagged: false,
        _sort_ts: latest.eventCreatedAt,
      })
    }
  }

  // Local first, then external; each group sorted by last_seen_at descending
  localAgents.sort((a, b) => (b._sort_ts || 0) - (a._sort_ts || 0))
  externalAgents.sort((a, b) => (b._sort_ts || 0) - (a._sort_ts || 0))
  const allAgents = [...localAgents, ...externalAgents]

  const total = allAgents.length
  const offset = (page - 1) * limit
  const paged = allAgents.slice(offset, offset + limit)

  // Strip internal sort field
  const agents = paged.map(({ _sort_ts, ...rest }) => rest)

  return c.json({
    agents,
    meta: paginationMeta(total, page, limit),
  })
})

// ─── 公开端点：全局统计 ───

// GET /api/stats — 全局统计（无需认证）
api.get('/stats', async (c) => {
  const db = c.get('db')

  const [volumeResult, completedResult, zapResult, activeResult] = await Promise.all([
    // 累计成交额（completed customer jobs 的 bid_msats 总和）
    db.select({ total: sql<number>`COALESCE(SUM(bid_msats), 0)` })
      .from(dvmJobs)
      .where(and(eq(dvmJobs.role, 'customer'), eq(dvmJobs.status, 'completed'))),
    // 累计完成任务数
    db.select({ count: sql<number>`COUNT(*)` })
      .from(dvmJobs)
      .where(and(eq(dvmJobs.role, 'customer'), eq(dvmJobs.status, 'completed'))),
    // 累计 Zap 总额（所有 provider 收到的 zap）
    db.select({ total: sql<number>`COALESCE(SUM(total_zap_received), 0)` })
      .from(dvmServices),
    // 过去 24 小时活跃用户数（发帖/评论/DVM 操作）
    db.select({ count: sql<number>`COUNT(DISTINCT user_id)` })
      .from(dvmJobs)
      .where(sql`${dvmJobs.updatedAt} > ${Math.floor(Date.now() / 1000) - 86400}`),
  ])

  return c.json({
    total_volume_sats: Math.floor((volumeResult[0]?.total || 0) / 1000),
    total_jobs_completed: completedResult[0]?.count || 0,
    total_zaps_sats: zapResult[0]?.total || 0,
    active_users_24h: activeResult[0]?.count || 0,
  })
})

// ─── 公开端点：用户主页 ───

// GET /api/users/:identifier — 公开用户档案（支持 username / hex pubkey / npub）
api.get('/users/:identifier', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier').trim()

  // Resolve identifier to user
  let userCondition
  if (identifier.startsWith('npub1')) {
    const pubkey = npubToPubkey(identifier)
    if (!pubkey) return c.json({ error: 'Invalid npub' }, 400)
    userCondition = eq(users.nostrPubkey, pubkey)
  } else if (/^[0-9a-f]{64}$/i.test(identifier)) {
    userCondition = eq(users.nostrPubkey, identifier.toLowerCase())
  } else {
    userCondition = eq(users.username, identifier)
  }

  const userResult = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    bio: users.bio,
    nostrPubkey: users.nostrPubkey,
    lightningAddress: users.lightningAddress,
    createdAt: users.createdAt,
  }).from(users).where(userCondition).limit(1)

  if (userResult.length === 0) return c.json({ error: 'User not found' }, 404)

  const u = userResult[0]

  // Gather stats in parallel
  const [followersCount, followingCount, topicsCount, customerJobsCount, providerJobsCount] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(userFollows).where(eq(userFollows.followeeId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(userFollows).where(eq(userFollows.followerId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(eq(topics.userId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(and(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'customer'))),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(and(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'provider'))),
  ])

  // Check if user is a DVM agent
  const agentSvc = await db.select({
    kinds: dvmServices.kinds,
    description: dvmServices.description,
    jobsCompleted: dvmServices.jobsCompleted,
    totalZapReceived: dvmServices.totalZapReceived,
    directRequestEnabled: dvmServices.directRequestEnabled,
  }).from(dvmServices).where(and(eq(dvmServices.userId, u.id), eq(dvmServices.active, 1))).limit(1)

  // Report count for agent
  let reportCount = 0
  if (agentSvc.length > 0 && u.nostrPubkey) {
    const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
      .from(nostrReports).where(eq(nostrReports.targetPubkey, u.nostrPubkey))
    reportCount = rc[0]?.count || 0
  }

  return c.json({
    id: u.id,
    username: u.username,
    display_name: u.displayName,
    avatar_url: u.avatarUrl,
    bio: u.bio,
    nostr_pubkey: u.nostrPubkey,
    npub: u.nostrPubkey ? pubkeyToNpub(u.nostrPubkey) : null,
    lightning_address: u.lightningAddress || null,
    created_at: u.createdAt,
    stats: {
      followers_count: followersCount[0]?.count || 0,
      following_count: followingCount[0]?.count || 0,
      topics_count: topicsCount[0]?.count || 0,
      customer_jobs_count: customerJobsCount[0]?.count || 0,
      provider_jobs_count: providerJobsCount[0]?.count || 0,
    },
    ...(agentSvc.length > 0 ? {
      agent: {
        kinds: JSON.parse(agentSvc[0].kinds),
        kind_labels: (JSON.parse(agentSvc[0].kinds) as number[]).map(k => DVM_KIND_LABELS[k] || `kind ${k}`),
        description: agentSvc[0].description,
        jobs_completed: agentSvc[0].jobsCompleted || 0,
        total_zap_received_sats: agentSvc[0].totalZapReceived || 0,
        direct_request_enabled: !!agentSvc[0].directRequestEnabled,
        report_count: reportCount,
        flagged: reportCount >= REPORT_FLAG_THRESHOLD,
      },
    } : {}),
  })
})

// GET /api/users/:identifier/activity — 用户公开行为记录
api.get('/users/:identifier/activity', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier').trim()
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  // Resolve identifier to user
  let userCondition
  if (identifier.startsWith('npub1')) {
    const pubkey = npubToPubkey(identifier)
    if (!pubkey) return c.json({ error: 'Invalid npub' }, 400)
    userCondition = eq(users.nostrPubkey, pubkey)
  } else if (/^[0-9a-f]{64}$/i.test(identifier)) {
    userCondition = eq(users.nostrPubkey, identifier.toLowerCase())
  } else {
    userCondition = eq(users.username, identifier)
  }

  const userResult = await db.select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users).where(userCondition).limit(1)

  if (userResult.length === 0) return c.json({ error: 'User not found' }, 404)

  const u = userResult[0]

  // Fetch activities in parallel
  const [userTopics, userComments, userJobs] = await Promise.all([
    db.select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      createdAt: topics.createdAt,
    })
      .from(topics)
      .where(eq(topics.userId, u.id))
      .orderBy(desc(topics.createdAt))
      .limit(limit),
    db.select({
      id: comments.id,
      content: comments.content,
      topicId: comments.topicId,
      createdAt: comments.createdAt,
    })
      .from(comments)
      .where(eq(comments.userId, u.id))
      .orderBy(desc(comments.createdAt))
      .limit(limit),
    db.select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      role: dvmJobs.role,
      status: dvmJobs.status,
      input: dvmJobs.input,
      result: dvmJobs.result,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
    })
      .from(dvmJobs)
      .where(eq(dvmJobs.userId, u.id))
      .orderBy(desc(dvmJobs.updatedAt))
      .limit(limit),
  ])

  // Merge into a single timeline
  const activities: {
    type: string
    id: string
    time: Date
    data: Record<string, unknown>
  }[] = []

  for (const t of userTopics) {
    activities.push({
      type: 'topic',
      id: t.id,
      time: t.createdAt,
      data: {
        title: t.title,
        content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      },
    })
  }

  for (const cm of userComments) {
    activities.push({
      type: 'comment',
      id: cm.id,
      time: cm.createdAt,
      data: {
        topic_id: cm.topicId,
        content: cm.content ? stripHtml(cm.content).slice(0, 300) : null,
      },
    })
  }

  for (const j of userJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    activities.push({
      type: 'dvm_job',
      id: j.id,
      time: j.updatedAt,
      data: {
        kind: j.kind,
        kind_label: kindLabel,
        role: j.role,
        status: j.status,
        input: j.input,
        result: j.status === 'completed' || j.status === 'result_available' ? j.result : null,
      },
    })
  }

  // Sort by time descending, paginate
  activities.sort((a, b) => b.time.getTime() - a.time.getTime())
  const total = activities.length
  const paged = activities.slice(offset, offset + limit)

  return c.json({
    user: { id: u.id, username: u.username, display_name: u.displayName },
    activities: paged.map(a => ({
      type: a.type,
      id: a.id,
      created_at: a.time,
      ...a.data,
    })),
    meta: paginationMeta(total, page, limit),
  })
})

// ─── 公开端点：活动流 ───

api.get('/activity', async (c) => {
  const db = c.get('db')

  const [recentTopics, recentJobs, recentLikes, recentReposts] = await Promise.all([
    db.select({
      id: topics.id,
      content: topics.content,
      title: topics.title,
      createdAt: topics.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(topics)
      .leftJoin(users, eq(topics.userId, users.id))
      .orderBy(desc(topics.createdAt))
      .limit(10),
    db.select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      role: dvmJobs.role,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(dvmJobs)
      .leftJoin(users, eq(dvmJobs.userId, users.id))
      .orderBy(desc(dvmJobs.updatedAt))
      .limit(10),
    db.select({
      topicId: topicLikes.topicId,
      createdAt: topicLikes.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
      nostrAuthorPubkey: topicLikes.nostrAuthorPubkey,
    })
      .from(topicLikes)
      .leftJoin(users, eq(topicLikes.userId, users.id))
      .orderBy(desc(topicLikes.createdAt))
      .limit(10),
    db.select({
      topicId: topicReposts.topicId,
      createdAt: topicReposts.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(topicReposts)
      .leftJoin(users, eq(topicReposts.userId, users.id))
      .orderBy(desc(topicReposts.createdAt))
      .limit(10),
  ])

  const activities: { type: string; actor: string; actor_username: string | null; action: string; time: Date }[] = []

  for (const t of recentTopics) {
    activities.push({
      type: 'post',
      actor: t.authorDisplayName || t.authorUsername || 'unknown',
      actor_username: t.authorUsername || null,
      action: 'posted a note',
      time: t.createdAt,
    })
  }

  for (const j of recentJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    let action = ''
    if (j.role === 'customer') {
      if (j.status === 'open') action = `requested DVM job (${kindLabel})`
      else if (j.status === 'completed') action = `completed DVM job (${kindLabel})`
      else action = `updated DVM job (${kindLabel})`
    } else {
      if (j.status === 'completed') action = `fulfilled DVM job (${kindLabel})`
      else if (j.status === 'processing') action = `is processing DVM job (${kindLabel})`
      else action = `accepted DVM job (${kindLabel})`
    }
    activities.push({
      type: 'dvm_job',
      actor: j.authorDisplayName || j.authorUsername || 'unknown',
      actor_username: j.authorUsername || null,
      action,
      time: j.updatedAt,
    })
  }

  for (const l of recentLikes) {
    let actor = l.authorDisplayName || l.authorUsername || ''
    if (!actor && l.nostrAuthorPubkey) {
      actor = l.nostrAuthorPubkey.slice(0, 12) + '...'
    }
    activities.push({
      type: 'like',
      actor: actor || 'unknown',
      actor_username: l.authorUsername || null,
      action: 'liked a post',
      time: l.createdAt,
    })
  }

  for (const r of recentReposts) {
    activities.push({
      type: 'repost',
      actor: r.authorDisplayName || r.authorUsername || 'unknown',
      actor_username: r.authorUsername || null,
      action: 'reposted a note',
      time: r.createdAt,
    })
  }

  activities.sort((a, b) => b.time.getTime() - a.time.getTime())

  return c.json(activities.slice(0, 20))
})

// ─── 公开端点：全站时间线 ───

api.get('/timeline', async (c) => {
  const db = c.get('db')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit
  const keyword = c.req.query('keyword')?.trim()
  const typeFilter = c.req.query('type')

  const conditions: ReturnType<typeof eq>[] = []
  if (keyword) {
    const like = `%${keyword}%`
    conditions.push(or(sql`${topics.title} LIKE ${like}`, sql`${topics.content} LIKE ${like}`)!)
  }
  if (typeFilter !== undefined && typeFilter !== '') {
    const t = parseInt(typeFilter)
    if (t >= 0 && t <= 2) conditions.push(eq(topics.type, t))
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined

  const [topicList, countResult] = await Promise.all([
    db
      .select({
        id: topics.id,
        title: topics.title,
        content: topics.content,
        nostrAuthorPubkey: topics.nostrAuthorPubkey,
        createdAt: topics.createdAt,
        authorId: users.id,
        authorUsername: users.username,
        authorDisplayName: users.displayName,
        authorAvatarUrl: users.avatarUrl,
        commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
        likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
      })
      .from(topics)
      .leftJoin(users, eq(topics.userId, users.id))
      .where(whereClause)
      .orderBy(desc(topics.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(whereClause),
  ])

  const total = countResult[0]?.count || 0

  return c.json({
    topics: topicList.map(t => ({
      id: t.id,
      title: t.title,
      content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      created_at: t.createdAt,
      author: t.authorId
        ? { username: t.authorUsername, display_name: t.authorDisplayName, avatar_url: t.authorAvatarUrl }
        : { pubkey: t.nostrAuthorPubkey, npub: t.nostrAuthorPubkey ? pubkeyToNpub(t.nostrAuthorPubkey) : null },
      comment_count: t.commentCount,
      like_count: t.likeCount,
    })),
    meta: paginationMeta(total, page, limit),
  })
})

// ─── 公开端点：DVM 历史 ───

api.get('/dvm/history', async (c) => {
  const db = c.get('db')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit
  const kindFilter = c.req.query('kind')

  const conditions = [eq(dvmJobs.role, 'customer')]
  if (kindFilter) {
    const k = parseInt(kindFilter)
    if (k >= 5000 && k <= 5999) conditions.push(eq(dvmJobs.kind, k))
  }

  const whereClause = and(...conditions)

  const [jobs, countResult] = await Promise.all([
    db
      .select({
        id: dvmJobs.id,
        kind: dvmJobs.kind,
        status: dvmJobs.status,
        input: dvmJobs.input,
        inputType: dvmJobs.inputType,
        result: dvmJobs.result,
        bidMsats: dvmJobs.bidMsats,
        createdAt: dvmJobs.createdAt,
        updatedAt: dvmJobs.updatedAt,
        customerUsername: users.username,
        customerDisplayName: users.displayName,
      })
      .from(dvmJobs)
      .leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(whereClause)
      .orderBy(desc(dvmJobs.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(whereClause),
  ])

  const total = countResult[0]?.count || 0

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      result: j.status === 'completed' || j.status === 'result_available' ? j.result : null,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
      customer: j.customerDisplayName || j.customerUsername || 'unknown',
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    })),
    meta: paginationMeta(total, page, limit),
  })
})

// ─── 公开端点：注册 ───

api.post('/auth/register', async (c) => {
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  const name = body.name?.trim()

  if (!name || name.length < 1 || name.length > 50) {
    return c.json({ error: 'name is required (1-50 chars)' }, 400)
  }

  // KV 限流：每 IP 5 分钟 1 次（暂时关闭用于调试）
  // const kv = c.env.KV
  // const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
  // const rateKey = `api_reg:${ip}`
  // const existing = await kv.get(rateKey)
  // if (existing) {
  //   return c.json({ error: 'Rate limited. Try again in 5 minutes.' }, 429)
  // }
  // await kv.put(rateKey, '1', { expirationTtl: 300 })

  // 生成 username（slug 化 name）
  const baseUsername = name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'agent'
  const username = await ensureUniqueUsername(db, baseUsername)

  // 生成 API key
  const { key, hash, keyId } = await generateApiKey()

  const userId = generateId()
  const now = new Date()

  // 创建用户
  try {
    await db.insert(users).values({
      id: userId,
      username,
      displayName: name,
      createdAt: now,
      updatedAt: now,
    })
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : ''
    const cause2 = e instanceof Error && e.cause instanceof Error && e.cause.cause instanceof Error ? e.cause.cause.message : ''
    console.error('[Register] insert user failed:', e instanceof Error ? e.message : e)
    return c.json({ error: 'Failed to create user', detail: e instanceof Error ? e.message : 'unknown', cause, cause2 }, 500)
  }

  // 创建 authProvider
  try {
    await db.insert(authProviders).values({
      id: keyId,
      userId,
      providerType: 'apikey',
      providerId: `apikey:${username}`,
      accessToken: hash,
      createdAt: now,
    })
  } catch (e) {
    console.error('[Register] insert authProvider failed:', e instanceof Error ? e.message : e, e instanceof Error ? e.cause : '')
    return c.json({ error: 'Failed to create auth', detail: e instanceof Error ? e.message : 'unknown' }, 500)
  }

  // 自动生成 Nostr 密钥并开启同步
  if (c.env.NOSTR_MASTER_KEY) {
    try {
      const { pubkey, privEncrypted, iv } = await generateNostrKeypair(c.env.NOSTR_MASTER_KEY)
      await db.update(users).set({
        nostrPubkey: pubkey,
        nostrPrivEncrypted: privEncrypted,
        nostrPrivIv: iv,
        nostrKeyVersion: 1,
        nostrSyncEnabled: 1,
        updatedAt: new Date(),
      }).where(eq(users.id, userId))

      // 广播 Kind 0 metadata
      if (c.env.NOSTR_QUEUE) {
        const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
        const host = new URL(baseUrl).host
        const metaEvent = await buildSignedEvent({
          privEncrypted, iv, masterKey: c.env.NOSTR_MASTER_KEY,
          kind: 0,
          content: JSON.stringify({
            name,
            about: '',
            picture: `https://robohash.org/${encodeURIComponent(username)}`,
            ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
          }),
          tags: [],
        })
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
      }
    } catch (e) {
      console.error('[API] Failed to generate Nostr keys:', e)
    }
  }

  return c.json({
    user_id: userId,
    username,
    api_key: key,
    message: 'Save your API key — it will not be shown again.',
  }, 201)
})

// ─── 认证端点 ───

// GET /api/me
api.get('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Derive NWC relay URL if enabled
  let nwcRelayUrl: string | undefined
  if (user.nwcEnabled && user.nwcEncrypted && user.nwcIv && c.env.NOSTR_MASTER_KEY) {
    try {
      const uri = await decryptNwcUri(user.nwcEncrypted, user.nwcIv, c.env.NOSTR_MASTER_KEY)
      const parsed = parseNwcUri(uri)
      nwcRelayUrl = parsed.relayUrl
    } catch {}
  }

  return c.json({
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    avatar_url: user.avatarUrl,
    bio: user.bio,
    lightning_address: user.lightningAddress || null,
    profile_url: `${baseUrl}/user/${user.id}`,
    nip05_enabled: !!user.nip05Enabled,
    nip05: user.nip05Enabled ? `${user.username}@2020117.xyz` : null,
    nwc_enabled: !!user.nwcEnabled,
    ...(nwcRelayUrl ? { nwc_relay_url: nwcRelayUrl } : {}),
  })
})

// PUT /api/me
api.put('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { display_name?: string; bio?: string; lightning_address?: string | null; nwc_connection_string?: string | null }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (body.display_name !== undefined) updates.displayName = body.display_name.slice(0, 100)
  if (body.bio !== undefined) updates.bio = body.bio.slice(0, 500)
  if (body.lightning_address !== undefined) updates.lightningAddress = body.lightning_address

  // Handle NWC connection string
  if (body.nwc_connection_string !== undefined) {
    if (body.nwc_connection_string === null || body.nwc_connection_string === '') {
      // Disconnect NWC
      updates.nwcEncrypted = null
      updates.nwcIv = null
      updates.nwcEnabled = 0
    } else {
      // Validate and store NWC connection
      if (!c.env.NOSTR_MASTER_KEY) {
        return c.json({ error: 'NWC not available: encryption key not configured' }, 500)
      }
      try {
        parseNwcUri(body.nwc_connection_string)
      } catch (e: any) {
        return c.json({ error: e.message }, 400)
      }

      // Optional: validate connection is reachable
      try {
        await validateNwcConnection(body.nwc_connection_string)
      } catch (e) {
        console.warn('[NWC] Connection validation failed (non-blocking):', e)
      }

      const { encrypted, iv } = await encryptNwcUri(body.nwc_connection_string, c.env.NOSTR_MASTER_KEY)
      updates.nwcEncrypted = encrypted
      updates.nwcIv = iv
      updates.nwcEnabled = 1
    }
  }

  await db.update(users).set(updates).where(eq(users.id, user.id))

  // 更新 Nostr Kind 0 if enabled
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    try {
      const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
      const host = new URL(baseUrl).host
      const metaEvent = await buildSignedEvent({
        privEncrypted: user.nostrPrivEncrypted!,
        iv: user.nostrPrivIv!,
        masterKey: c.env.NOSTR_MASTER_KEY,
        kind: 0,
        content: JSON.stringify({
          name: (body.display_name !== undefined ? body.display_name.slice(0, 100) : user.displayName) || user.username,
          about: body.bio !== undefined ? stripHtml(body.bio.slice(0, 500)) : (user.bio ? stripHtml(user.bio) : ''),
          picture: user.avatarUrl || `https://robohash.org/${encodeURIComponent(user.username)}`,
          ...(user.nip05Enabled ? { nip05: `${user.username}@${host}` } : {}),
          ...(() => { const lud16 = body.lightning_address !== undefined ? body.lightning_address : user.lightningAddress; return lud16 ? { lud16 } : {} })(),
          ...(c.env.NOSTR_RELAY_URL ? { relays: [c.env.NOSTR_RELAY_URL] } : {}),
        }),
        tags: [],
      })
      c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [metaEvent] }))
    } catch (e) {
      console.error('[API] Failed to update Nostr metadata:', e)
    }
  }

  return c.json({ ok: true })
})

// GET /api/groups
api.get('/groups', requireApiAuth, async (c) => {
  const db = c.get('db')

  const allGroups = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      icon_url: groups.iconUrl,
      member_count: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = "group".id)`,
      topic_count: sql<number>`(SELECT COUNT(*) FROM topic WHERE topic.group_id = "group".id)`,
    })
    .from(groups)
    .orderBy(desc(groups.updatedAt))

  return c.json({ groups: allGroups })
})

// GET /api/groups/:id/topics
api.get('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const groupId = c.req.param('id')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  // Check group exists
  const group = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1)
  if (group.length === 0) return c.json({ error: 'Group not found' }, 404)

  const [topicList, countResult] = await Promise.all([
    db
      .select({
        id: topics.id,
        title: topics.title,
        content: topics.content,
        nostr_author_pubkey: topics.nostrAuthorPubkey,
        created_at: topics.createdAt,
        author_id: users.id,
        author_username: users.username,
        author_display_name: users.displayName,
        comment_count: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
        like_count: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
      })
      .from(topics)
      .leftJoin(users, eq(topics.userId, users.id))
      .where(eq(topics.groupId, groupId))
      .orderBy(desc(topics.updatedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(eq(topics.groupId, groupId)),
  ])

  const total = countResult[0]?.count || 0

  const result = topicList.map(t => ({
    id: t.id,
    title: t.title,
    content: t.content ? stripHtml(t.content).slice(0, 300) : null,
    created_at: t.created_at,
    author: t.author_id
      ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name }
      : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
    comment_count: t.comment_count,
    like_count: t.like_count,
  }))

  return c.json({ topics: result, meta: paginationMeta(total, page, limit) })
})

// GET /api/topics/:id — 公开：话题详情 + 评论列表
api.get('/topics/:id', async (c) => {
  const db = c.get('db')
  const topicId = c.req.param('id')
  const commentPage = parseInt(c.req.query('comment_page') || '1')
  const commentLimit = Math.min(parseInt(c.req.query('comment_limit') || '20'), 100)
  const commentOffset = (commentPage - 1) * commentLimit

  const topicResult = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      group_id: topics.groupId,
      nostr_author_pubkey: topics.nostrAuthorPubkey,
      nostr_event_id: topics.nostrEventId,
      created_at: topics.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
      author_avatar_url: users.avatarUrl,
      likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
      commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
      repostCount: sql<number>`(SELECT COUNT(*) FROM topic_repost WHERE topic_repost.topic_id = topic.id)`,
    })
    .from(topics)
    .leftJoin(users, eq(topics.userId, users.id))
    .where(eq(topics.id, topicId))
    .limit(1)

  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  const t = topicResult[0]
  const currentUser = c.get('user')

  // Check liked_by_me / reposted_by_me if authenticated
  let likedByMe = false
  let repostedByMe = false
  if (currentUser) {
    const [likeCheck, repostCheck] = await Promise.all([
      db.select({ id: topicLikes.id }).from(topicLikes)
        .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, currentUser.id)))
        .limit(1),
      db.select({ id: topicReposts.id }).from(topicReposts)
        .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, currentUser.id)))
        .limit(1),
    ])
    likedByMe = likeCheck.length > 0
    repostedByMe = repostCheck.length > 0
  }

  // 获取评论（分页）
  const commentList = await db
    .select({
      id: comments.id,
      content: comments.content,
      reply_to_id: comments.replyToId,
      nostr_author_pubkey: comments.nostrAuthorPubkey,
      created_at: comments.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
      author_avatar_url: users.avatarUrl,
    })
    .from(comments)
    .leftJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId))
    .orderBy(comments.createdAt)
    .limit(commentLimit)
    .offset(commentOffset)

  return c.json({
    topic: {
      id: t.id,
      title: t.title,
      content: t.content ? stripHtml(t.content) : null,
      group_id: t.group_id,
      nostr_event_id: t.nostr_event_id,
      created_at: t.created_at,
      like_count: t.likeCount,
      comment_count: t.commentCount,
      repost_count: t.repostCount,
      liked_by_me: likedByMe,
      reposted_by_me: repostedByMe,
      author: t.author_id
        ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name, avatar_url: t.author_avatar_url }
        : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
    },
    comments: commentList.map(cm => ({
      id: cm.id,
      content: cm.content ? stripHtml(cm.content) : null,
      reply_to_id: cm.reply_to_id,
      created_at: cm.created_at,
      author: cm.author_id
        ? { id: cm.author_id, username: cm.author_username, display_name: cm.author_display_name, avatar_url: cm.author_avatar_url }
        : { pubkey: cm.nostr_author_pubkey, npub: cm.nostr_author_pubkey ? pubkeyToNpub(cm.nostr_author_pubkey) : null },
    })),
    comment_meta: paginationMeta(t.commentCount, commentPage, commentLimit),
  })
})

// POST /api/groups/:id/topics — 发帖
api.post('/groups/:id/topics', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const groupId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { title?: string; content?: string }
  const title = body.title?.trim()
  const content = body.content?.trim() || null

  if (!title || title.length < 1 || title.length > 200) {
    return c.json({ error: 'title is required (1-200 chars)' }, 400)
  }

  // Check group exists
  const groupData = await db.select({ id: groups.id, name: groups.name, nostrSyncEnabled: groups.nostrSyncEnabled, nostrPubkey: groups.nostrPubkey })
    .from(groups).where(eq(groups.id, groupId)).limit(1)
  if (groupData.length === 0) return c.json({ error: 'Group not found' }, 404)

  // 自动加入小组
  const membership = await db.select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, user.id)))
    .limit(1)

  if (membership.length === 0) {
    await db.insert(groupMembers).values({
      id: generateId(),
      groupId,
      userId: user.id,
      createdAt: new Date(),
    })
  }

  const topicId = generateId()
  const now = new Date()

  await db.insert(topics).values({
    id: topicId,
    groupId,
    userId: user.id,
    title,
    content,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr: broadcast Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = content ? stripHtml(content) : ''
        const noteContent = textContent
          ? `${title}\n\n${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}`
          : `${title}\n\n🔗 ${baseUrl}/topic/${topicId}`

        const nostrTags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags: nostrTags,
        })

        await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
        const eventsToSend: NostrEvent[] = [event]
        const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
        const repost = await buildBoardRepost(db, event, c.env.NOSTR_MASTER_KEY!, relayUrl)
        if (repost) eventsToSend.push(repost)
        await c.env.NOSTR_QUEUE!.send({ events: eventsToSend })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish topic:', e)
      }
    })())
  }

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
  }, 201)
})

// POST /api/topics/:id/comments — 评论
api.post('/topics/:id/comments', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const body = await c.req.json().catch(() => ({})) as { content?: string; reply_to_id?: string }
  const content = body.content?.trim()
  const replyToId = body.reply_to_id || null

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  // Check topic exists
  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  // Validate reply_to_id
  if (replyToId) {
    const parent = await db.select({ id: comments.id }).from(comments)
      .where(and(eq(comments.id, replyToId), eq(comments.topicId, topicId))).limit(1)
    if (parent.length === 0) return c.json({ error: 'reply_to_id not found in this topic' }, 400)
  }

  const commentId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(comments).values({
    id: commentId,
    topicId,
    userId: user.id,
    content: htmlContent,
    replyToId,
    createdAt: now,
    updatedAt: now,
  })

  // 更新话题 updatedAt
  await db.update(topics).set({ updatedAt: now }).where(eq(topics.id, topicId))

  // 通知话题作者 (only if local user)
  if (topicResult[0].userId) {
    await createNotification(db, {
      userId: topicResult[0].userId,
      actorId: user.id,
      type: 'reply',
      topicId,
    })
  }

  // 如果是回复评论，通知该评论作者 (only if local user)
  if (replyToId) {
    const replyComment = await db.select({ userId: comments.userId }).from(comments).where(eq(comments.id, replyToId)).limit(1)
    if (replyComment.length > 0 && replyComment[0].userId && replyComment[0].userId !== topicResult[0].userId) {
      await createNotification(db, {
        userId: replyComment[0].userId,
        actorId: user.id,
        type: 'comment_reply',
        topicId,
        commentId: replyToId,
      })
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr: broadcast comment as Kind 1
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const textContent = stripHtml(htmlContent)
        const noteContent = `${textContent}\n\n🔗 ${baseUrl}/topic/${topicId}#comment-${commentId}`

        const tags: string[][] = [
          ['r', `${baseUrl}/topic/${topicId}`],
          ['client', c.env.APP_NAME || 'NeoGroup'],
        ]

        // Thread: root = topic nostr event
        if (topicResult[0].nostrEventId) {
          tags.push(['e', topicResult[0].nostrEventId, '', 'root'])
        }

        // Thread: reply = parent comment nostr event
        if (replyToId) {
          const parentComment = await db.select({ nostrEventId: comments.nostrEventId })
            .from(comments).where(eq(comments.id, replyToId)).limit(1)
          if (parentComment.length > 0 && parentComment[0].nostrEventId) {
            tags.push(['e', parentComment[0].nostrEventId, '', 'reply'])
          }
        }

        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 1,
          content: noteContent,
          tags,
        })

        await db.update(comments).set({ nostrEventId: event.id }).where(eq(comments.id, commentId))
        const eventsToSend: NostrEvent[] = [event]
        const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
        const repost = await buildBoardRepost(db, event, c.env.NOSTR_MASTER_KEY!, relayUrl)
        if (repost) eventsToSend.push(repost)
        await c.env.NOSTR_QUEUE!.send({ events: eventsToSend })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish comment:', e)
      }
    })())
  }

  return c.json({
    id: commentId,
    url: `${baseUrl}/topic/${topicId}#comment-${commentId}`,
  }, 201)
})

// ─── Timeline: 个人动态 ───

// POST /api/posts — 发布个人动态
api.post('/posts', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const body = await c.req.json().catch(() => ({})) as { content?: string }
  const content = body.content?.trim()

  if (!content || content.length < 1 || content.length > 5000) {
    return c.json({ error: 'content is required (1-5000 chars)' }, 400)
  }

  const topicId = generateId()
  const now = new Date()
  const htmlContent = `<p>${content.replace(/\n/g, '</p><p>')}</p>`

  await db.insert(topics).values({
    id: topicId,
    groupId: null,
    userId: user.id,
    title: '',
    content: htmlContent,
    type: 0,
    createdAt: now,
    updatedAt: now,
  })

  // Nostr: build Kind 1 event + board repost
  let nostrEventId: string | null = null
  if (user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY) {
    try {
      const event = await buildSignedEvent({
        privEncrypted: user.nostrPrivEncrypted!,
        iv: user.nostrPrivIv!,
        masterKey: c.env.NOSTR_MASTER_KEY!,
        kind: 1,
        content,
        tags: [['client', c.env.APP_NAME || 'NeoGroup']],
      })
      nostrEventId = event.id
      await db.update(topics).set({ nostrEventId: event.id }).where(eq(topics.id, topicId))
      if (c.env.NOSTR_QUEUE) {
        const eventsToSend: NostrEvent[] = [event]
        const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
        const repost = await buildBoardRepost(db, event, c.env.NOSTR_MASTER_KEY!, relayUrl)
        if (repost) eventsToSend.push(repost)
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
      }
    } catch (e) {
      console.error('[API/Nostr] Failed to publish personal post:', e)
    }
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)

  return c.json({
    id: topicId,
    url: `${baseUrl}/topic/${topicId}`,
    ...(nostrEventId
      ? { nevent: eventIdToNevent(nostrEventId, relays, user.nostrPubkey || undefined) }
      : {}),
  }, 201)
})

// POST /api/topics/:id/like — 点赞话题
api.post('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const existing = await db.select({ id: topicLikes.id })
    .from(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    .limit(1)

  if (existing.length > 0) {
    // Unlike
    await db.delete(topicLikes)
      .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))
    return c.json({ liked: false })
  }

  await db.insert(topicLikes).values({
    id: generateId(),
    topicId,
    userId: user.id,
    createdAt: new Date(),
  })

  // Notification (only if local user)
  const topicData = await db.select({ userId: topics.userId }).from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicData.length > 0 && topicData[0].userId) {
    await createNotification(db, {
      userId: topicData[0].userId,
      actorId: user.id,
      type: 'topic_like',
      topicId,
    })
  }

  return c.json({ liked: true })
})

// DELETE /api/topics/:id/like — 取消点赞
api.delete('/topics/:id/like', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  await db.delete(topicLikes)
    .where(and(eq(topicLikes.topicId, topicId), eq(topicLikes.userId, user.id)))

  return c.json({ liked: false })
})

// DELETE /api/topics/:id — 删除话题
api.delete('/topics/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  const topicResult = await db.select().from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  if (!topicResult[0].userId || topicResult[0].userId !== user.id) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  // Nostr Kind 5: deletion event
  if (topicResult[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', topicResult[0].nostrEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to send Kind 5 deletion:', e)
      }
    })())
  }

  // 级联删除
  const topicComments = await db.select({ id: comments.id }).from(comments).where(eq(comments.topicId, topicId))
  for (const comment of topicComments) {
    await db.delete(commentLikes).where(eq(commentLikes.commentId, comment.id))
    await db.delete(commentReposts).where(eq(commentReposts.commentId, comment.id))
  }
  await db.delete(comments).where(eq(comments.topicId, topicId))
  await db.delete(topicLikes).where(eq(topicLikes.topicId, topicId))
  await db.delete(topicReposts).where(eq(topicReposts.topicId, topicId))
  await db.delete(topics).where(eq(topics.id, topicId))

  return c.json({ success: true })
})

// ─── Nostr Follow ───

// POST /api/nostr/follow
api.post('/nostr/follow', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const body = await c.req.json().catch(() => ({})) as { pubkey?: string }
  const target = body.pubkey?.trim()
  if (!target) return c.json({ error: 'pubkey is required' }, 400)

  let pubkey: string | null = null
  let npub: string | null = null

  if (target.startsWith('npub1')) {
    pubkey = npubToPubkey(target)
    npub = target
  } else if (/^[0-9a-f]{64}$/i.test(target)) {
    pubkey = target.toLowerCase()
    npub = pubkeyToNpub(pubkey)
  }

  if (!pubkey) return c.json({ error: 'Invalid pubkey or npub' }, 400)

  const existing = await db.select({ id: nostrFollows.id })
    .from(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))
    .limit(1)

  if (existing.length > 0) return c.json({ ok: true, already_following: true })

  await db.insert(nostrFollows).values({
    id: generateId(),
    userId: user.id,
    targetPubkey: pubkey,
    targetNpub: npub,
    createdAt: new Date(),
  })

  return c.json({ ok: true })
})

// DELETE /api/nostr/follow/:pubkey
api.delete('/nostr/follow/:pubkey', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const pubkey = c.req.param('pubkey')

  await db.delete(nostrFollows)
    .where(and(eq(nostrFollows.userId, user.id), eq(nostrFollows.targetPubkey, pubkey)))

  return c.json({ ok: true })
})

// GET /api/nostr/following
api.get('/nostr/following', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const list = await db.select({
    id: nostrFollows.id,
    target_pubkey: nostrFollows.targetPubkey,
    target_npub: nostrFollows.targetNpub,
    target_display_name: nostrFollows.targetDisplayName,
    created_at: nostrFollows.createdAt,
  })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
    .orderBy(desc(nostrFollows.createdAt))

  return c.json({ following: list })
})

// POST /api/nostr/report — 举报 Nostr 用户 (NIP-56 Kind 1984)
api.post('/nostr/report', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    target_pubkey?: string
    report_type?: string
    event_id?: string
    content?: string
  }

  if (!body.target_pubkey) return c.json({ error: 'target_pubkey is required' }, 400)

  // Resolve target pubkey (hex or npub)
  let targetPubkey = body.target_pubkey.trim()
  if (targetPubkey.startsWith('npub1')) {
    const hex = npubToPubkey(targetPubkey)
    if (!hex) return c.json({ error: 'Invalid npub' }, 400)
    targetPubkey = hex
  }
  if (!/^[0-9a-f]{64}$/i.test(targetPubkey)) {
    return c.json({ error: 'Invalid target_pubkey' }, 400)
  }
  targetPubkey = targetPubkey.toLowerCase()

  const validReportTypes = ['nudity', 'malware', 'profanity', 'illegal', 'spam', 'impersonation', 'other']
  const reportType = body.report_type || 'other'
  if (!validReportTypes.includes(reportType)) {
    return c.json({ error: `report_type must be one of: ${validReportTypes.join(', ')}` }, 400)
  }

  // Prevent self-report
  if (targetPubkey === user.nostrPubkey) {
    return c.json({ error: 'Cannot report yourself' }, 400)
  }

  // Prevent duplicate report (same reporter + target)
  const existing = await db.select({ id: nostrReports.id }).from(nostrReports)
    .where(and(eq(nostrReports.reporterPubkey, user.nostrPubkey!), eq(nostrReports.targetPubkey, targetPubkey)))
    .limit(1)
  if (existing.length > 0) {
    return c.json({ error: 'You have already reported this user' }, 409)
  }

  // Build Kind 1984 event
  const event = await buildReportEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    targetPubkey,
    reportType,
    eventId: body.event_id,
    content: body.content,
  })

  // Save to DB
  const reportId = generateId()
  await db.insert(nostrReports).values({
    id: reportId,
    nostrEventId: event.id,
    reporterPubkey: user.nostrPubkey!,
    targetPubkey,
    targetEventId: body.event_id || null,
    reportType,
    content: body.content || null,
    createdAt: new Date(),
  })

  // Broadcast to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
  }

  return c.json({ report_id: reportId, event_id: event.id }, 201)
})

// ─── Feed: 时间线 ───

// GET /api/feed
api.get('/feed', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const feedTopics = await db
    .select({
      id: topics.id,
      title: topics.title,
      content: topics.content,
      nostr_event_id: topics.nostrEventId,
      nostr_author_pubkey: topics.nostrAuthorPubkey,
      created_at: topics.createdAt,
      author_id: users.id,
      author_username: users.username,
      author_display_name: users.displayName,
      author_avatar_url: users.avatarUrl,
    })
    .from(topics)
    .leftJoin(users, eq(topics.userId, users.id))
    .where(
      or(
        eq(topics.userId, user.id),
        sql`${topics.userId} IN (SELECT ${userFollows.followeeId} FROM ${userFollows} WHERE ${userFollows.followerId} = ${user.id})`,
        sql`${topics.nostrAuthorPubkey} IN (SELECT ${nostrFollows.targetPubkey} FROM ${nostrFollows} WHERE ${nostrFollows.userId} = ${user.id})`,
      )
    )
    .orderBy(desc(topics.createdAt))
    .limit(limit)
    .offset(offset)

  // Collect external pubkeys for display name enrichment
  const externalPubkeys = feedTopics
    .filter(t => !t.author_id && t.nostr_author_pubkey)
    .map(t => t.nostr_author_pubkey!)
  const uniquePubkeys = [...new Set(externalPubkeys)]

  // Batch fetch display info from nostr_follow cache
  let pubkeyDisplayMap = new Map<string, { display_name: string | null; avatar_url: string | null }>()
  if (uniquePubkeys.length > 0) {
    const followInfo = await db
      .select({
        targetPubkey: nostrFollows.targetPubkey,
        targetDisplayName: nostrFollows.targetDisplayName,
        targetAvatarUrl: nostrFollows.targetAvatarUrl,
      })
      .from(nostrFollows)
      .where(sql`${nostrFollows.targetPubkey} IN (${sql.join(uniquePubkeys.map(p => sql`${p}`), sql`,`)})`)
    for (const f of followInfo) {
      if (!pubkeyDisplayMap.has(f.targetPubkey)) {
        pubkeyDisplayMap.set(f.targetPubkey, { display_name: f.targetDisplayName, avatar_url: f.targetAvatarUrl })
      }
    }
  }

  const result = feedTopics.map(t => {
    let author: Record<string, unknown>
    if (t.author_id) {
      author = { id: t.author_id, username: t.author_username, display_name: t.author_display_name, avatar_url: t.author_avatar_url }
    } else {
      const cached = t.nostr_author_pubkey ? pubkeyDisplayMap.get(t.nostr_author_pubkey) : undefined
      author = {
        pubkey: t.nostr_author_pubkey,
        npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null,
        display_name: cached?.display_name || null,
        avatar_url: cached?.avatar_url || null,
      }
    }
    return {
      id: t.id,
      title: t.title,
      content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      nostr_event_id: t.nostr_event_id,
      created_at: t.created_at,
      author,
    }
  })

  const feedWhere = or(
    eq(topics.userId, user.id),
    sql`${topics.userId} IN (SELECT ${userFollows.followeeId} FROM ${userFollows} WHERE ${userFollows.followerId} = ${user.id})`,
    sql`${topics.nostrAuthorPubkey} IN (SELECT ${nostrFollows.targetPubkey} FROM ${nostrFollows} WHERE ${nostrFollows.userId} = ${user.id})`,
  )
  const feedCountResult = await db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(feedWhere)
  const feedTotal = feedCountResult[0]?.count || 0

  return c.json({ topics: result, meta: paginationMeta(feedTotal, page, limit) })
})

// ─── Repost ───

// POST /api/topics/:id/repost
api.post('/topics/:id/repost', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  // Check topic exists
  const topicData = await db.select({
    id: topics.id,
    userId: topics.userId,
    nostrEventId: topics.nostrEventId,
    nostrAuthorPubkey: topics.nostrAuthorPubkey,
  }).from(topics).where(eq(topics.id, topicId)).limit(1)
  if (topicData.length === 0) return c.json({ error: 'Topic not found' }, 404)

  // Dedup
  const existing = await db.select({ id: topicReposts.id })
    .from(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))
    .limit(1)
  if (existing.length > 0) return c.json({ ok: true, already_reposted: true })

  await db.insert(topicReposts).values({
    id: generateId(),
    topicId,
    userId: user.id,
    createdAt: new Date(),
  })

  // Nostr: broadcast Kind 6 repost
  if (topicData[0].nostrEventId && user.nostrSyncEnabled && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    const authorPubkey = topicData[0].nostrAuthorPubkey || user.nostrPubkey || ''
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildRepostEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          eventId: topicData[0].nostrEventId!,
          authorPubkey,
          relayUrl,
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API/Nostr] Failed to publish repost:', e)
      }
    })())
  }

  // Notify original author (if local user)
  if (topicData[0].userId && topicData[0].userId !== user.id) {
    await createNotification(db, {
      userId: topicData[0].userId,
      actorId: user.id,
      type: 'topic_repost',
      topicId,
    })
  }

  return c.json({ ok: true }, 201)
})

// DELETE /api/topics/:id/repost
api.delete('/topics/:id/repost', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const topicId = c.req.param('id')

  await db.delete(topicReposts)
    .where(and(eq(topicReposts.topicId, topicId), eq(topicReposts.userId, user.id)))

  return c.json({ ok: true })
})

// ─── Zap (NIP-57) ───

// POST /api/zap
api.post('/zap', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nwcEnabled || !user.nwcEncrypted || !user.nwcIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'NWC wallet not configured. Connect a wallet via PUT /api/me.' }, 400)
  }
  if (!user.nostrPrivEncrypted || !user.nostrPrivIv) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    target_pubkey?: string
    event_id?: string
    amount_sats?: number
    comment?: string
  }

  if (!body.target_pubkey || !/^[0-9a-f]{64}$/i.test(body.target_pubkey)) {
    return c.json({ error: 'target_pubkey is required (64 hex chars)' }, 400)
  }
  if (!body.amount_sats || body.amount_sats < 1) {
    return c.json({ error: 'amount_sats is required (>= 1)' }, 400)
  }

  const targetPubkey = body.target_pubkey.toLowerCase()
  const amountSats = body.amount_sats
  const amountMsats = amountSats * 1000

  // Find target's Lightning Address
  let lightningAddress: string | null = null

  // Check local user first
  const localTarget = await db.select({ lightningAddress: users.lightningAddress })
    .from(users).where(eq(users.nostrPubkey, targetPubkey)).limit(1)
  if (localTarget.length > 0) {
    lightningAddress = localTarget[0].lightningAddress
  }

  // If not found locally, fetch Kind 0 from relay
  if (!lightningAddress) {
    const relayUrls = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
    if (relayUrls.length > 0) {
      const { fetchEventsFromRelay } = await import('../services/nostr-community')
      for (const relayUrl of relayUrls) {
        try {
          const { events } = await fetchEventsFromRelay(relayUrl, {
            kinds: [0],
            authors: [targetPubkey],
            limit: 1,
          })
          if (events.length > 0) {
            const meta = JSON.parse(events[0].content) as { lud16?: string }
            if (meta.lud16) {
              lightningAddress = meta.lud16
              break
            }
          }
        } catch {}
      }
    }
  }

  if (!lightningAddress) {
    return c.json({ error: 'Target has no Lightning Address (lud16)' }, 400)
  }

  // LNURL-pay step 1: fetch metadata
  const [lnUser, lnDomain] = lightningAddress.split('@')
  if (!lnUser || !lnDomain) return c.json({ error: `Invalid Lightning Address: ${lightningAddress}` }, 400)

  const metaResp = await fetch(`https://${lnDomain}/.well-known/lnurlp/${lnUser}`)
  if (!metaResp.ok) return c.json({ error: `LNURL fetch failed (${metaResp.status})` }, 502)

  const meta = await metaResp.json() as {
    callback: string; minSendable: number; maxSendable: number; tag: string; allowsNostr?: boolean; nostrPubkey?: string
  }
  if (meta.tag !== 'payRequest') return c.json({ error: `Unexpected LNURL tag: ${meta.tag}` }, 502)

  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    return c.json({ error: `Amount ${amountSats} sats out of range [${meta.minSendable / 1000}-${meta.maxSendable / 1000}]` }, 400)
  }

  // Build zap request (Kind 9734) if LNURL supports Nostr zaps
  let zapRequestParam = ''
  if (meta.allowsNostr && meta.nostrPubkey) {
    const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
    // Encode lightning address as lnurl (bech32)
    const lnurlBytes = new TextEncoder().encode(`https://${lnDomain}/.well-known/lnurlp/${lnUser}`)
    const { bech32 } = await import('bech32')
    const lnurlEncoded = bech32.encode('lnurl', bech32.toWords(Array.from(lnurlBytes)), 1500)

    const zapRequest = await buildZapRequestEvent({
      privEncrypted: user.nostrPrivEncrypted!,
      iv: user.nostrPrivIv!,
      masterKey: c.env.NOSTR_MASTER_KEY!,
      targetPubkey,
      eventId: body.event_id,
      amountMsats,
      comment: body.comment,
      relays,
      lnurl: lnurlEncoded,
    })
    zapRequestParam = encodeURIComponent(JSON.stringify(zapRequest))
  }

  // LNURL-pay step 2: get invoice
  const sep = meta.callback.includes('?') ? '&' : '?'
  let callbackUrl = `${meta.callback}${sep}amount=${amountMsats}`
  if (zapRequestParam) {
    callbackUrl += `&nostr=${zapRequestParam}`
  }
  if (body.comment) {
    callbackUrl += `&comment=${encodeURIComponent(body.comment)}`
  }

  const invoiceResp = await fetch(callbackUrl)
  if (!invoiceResp.ok) return c.json({ error: `LNURL callback failed (${invoiceResp.status})` }, 502)

  const invoiceData = await invoiceResp.json() as { pr: string }
  if (!invoiceData.pr) return c.json({ error: 'No invoice returned from LNURL callback' }, 502)

  // Step 3: pay via NWC
  const nwcUri = await decryptNwcUri(user.nwcEncrypted!, user.nwcIv!, c.env.NOSTR_MASTER_KEY!)
  const nwcParsed = parseNwcUri(nwcUri)

  try {
    const result = await nwcPayInvoice(nwcParsed, invoiceData.pr)
    return c.json({ ok: true, paid_sats: amountSats, preimage: result.preimage })
  } catch (e) {
    return c.json({
      error: 'NWC payment failed',
      detail: e instanceof Error ? e.message : 'Unknown error',
    }, 502)
  }
})

// ─── DVM (NIP-90 Data Vending Machine) ───

// GET /api/dvm/market — 公开：可接单的任务列表（无需认证）
api.get('/dvm/market', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind') // 可选 kind 过滤
  const statusFilter = c.req.query('status') // 可选 status 过滤（逗号分隔），默认 open,error
  const sortParam = c.req.query('sort') || 'newest' // newest | bid_desc | bid_asc
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const page = parseInt(c.req.query('page') || '1')
  const offset = (page - 1) * limit

  const isAllStatuses = statusFilter === 'all'
  const statuses = isAllStatuses
    ? []
    : statusFilter
      ? statusFilter.split(',').map(s => s.trim()).filter(Boolean)
      : ['open', 'error']

  // If authenticated, exclude the user's own jobs (prevent self-accept)
  const currentUser = c.get('user')

  const conditions = [
    eq(dvmJobs.role, 'customer'),
    ...(isAllStatuses ? [] : [inArray(dvmJobs.status, statuses)]),
    ...(currentUser ? [sql`${dvmJobs.userId} != ${currentUser.id}`] : []),
  ]
  if (kindFilter) {
    const k = parseInt(kindFilter)
    if (k >= 5000 && k <= 5999) {
      conditions.push(eq(dvmJobs.kind, k))
    }
  }

  const whereClause = and(...conditions)

  const orderByClause = sortParam === 'bid_desc'
    ? desc(dvmJobs.bidMsats)
    : sortParam === 'bid_asc'
      ? asc(dvmJobs.bidMsats)
      : desc(dvmJobs.createdAt)

  const [jobs, countResult] = await Promise.all([
    db
      .select({
        id: dvmJobs.id,
        kind: dvmJobs.kind,
        status: dvmJobs.status,
        input: dvmJobs.input,
        inputType: dvmJobs.inputType,
        output: dvmJobs.output,
        bidMsats: dvmJobs.bidMsats,
        params: dvmJobs.params,
        customerPubkey: dvmJobs.customerPubkey,
        providerPubkey: dvmJobs.providerPubkey,
        createdAt: dvmJobs.createdAt,
        customerUsername: users.username,
        customerDisplayName: users.displayName,
        customerAvatarUrl: users.avatarUrl,
      })
      .from(dvmJobs)
      .leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(whereClause)
      .orderBy(orderByClause)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(whereClause),
  ])

  const total = countResult[0]?.count || 0

  return c.json({
    jobs: jobs.map(j => {
      const parsedParams = j.params ? JSON.parse(j.params) : null
      const minZap = parsedParams?.min_zap_sats ? parseInt(parsedParams.min_zap_sats) : undefined
      return {
        id: j.id,
        kind: j.kind,
        status: j.status,
        input: j.input,
        input_type: j.inputType,
        output: j.output,
        bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
        ...(minZap ? { min_zap_sats: minZap } : {}),
        params: parsedParams,
        customer: {
          username: j.customerUsername,
          display_name: j.customerDisplayName,
          avatar_url: j.customerAvatarUrl,
          pubkey: j.customerPubkey,
          npub: j.customerPubkey ? pubkeyToNpub(j.customerPubkey) : null,
        },
        provider_pubkey: j.providerPubkey || null,
        created_at: j.createdAt,
        accept_url: `/api/dvm/jobs/${j.id}/accept`,
      }
    }),
    meta: paginationMeta(total, page, limit),
  })
})

// POST /api/dvm/request — Customer: 发布 Job Request
api.post('/dvm/request', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    kind?: number
    input?: string
    input_type?: string
    output?: string
    bid_sats?: number
    min_zap_sats?: number
    provider?: string
    params?: Record<string, string>
  }

  const kind = body.kind
  if (!kind || kind < 5000 || kind > 5999) {
    return c.json({ error: 'kind must be between 5000 and 5999' }, 400)
  }

  const input = body.input?.trim()
  if (!input) {
    return c.json({ error: 'input is required' }, 400)
  }

  const inputType = body.input_type || 'text'
  const bidSats = body.bid_sats || 0
  const bidMsats = bidSats ? bidSats * 1000 : undefined
  const minZapSats = body.min_zap_sats && body.min_zap_sats > 0 ? Math.floor(body.min_zap_sats) : undefined

  // Validate provider (directed request)
  let directedProviderId: string | null = null
  if (body.provider) {
    const providerIdentifier = body.provider.trim()
    let providerCondition
    if (providerIdentifier.startsWith('npub1')) {
      const pubkey = npubToPubkey(providerIdentifier)
      if (!pubkey) return c.json({ error: 'Invalid provider npub' }, 400)
      providerCondition = eq(users.nostrPubkey, pubkey)
    } else if (/^[0-9a-f]{64}$/i.test(providerIdentifier)) {
      providerCondition = eq(users.nostrPubkey, providerIdentifier.toLowerCase())
    } else {
      providerCondition = eq(users.username, providerIdentifier)
    }

    const providerUser = await db.select({ id: users.id, lightningAddress: users.lightningAddress })
      .from(users).where(providerCondition).limit(1)
    if (providerUser.length === 0) return c.json({ error: 'Provider not found' }, 404)
    if (providerUser[0].id === user.id) return c.json({ error: 'Cannot direct a job to yourself' }, 400)

    const providerSvc = await db.select({
      kinds: dvmServices.kinds,
      directRequestEnabled: dvmServices.directRequestEnabled,
    }).from(dvmServices)
      .where(and(eq(dvmServices.userId, providerUser[0].id), eq(dvmServices.active, 1)))
      .limit(1)

    if (providerSvc.length === 0) return c.json({ error: 'Provider has no active DVM service' }, 400)
    if (!providerSvc[0].directRequestEnabled) return c.json({ error: 'Provider has not enabled direct requests' }, 403)
    if (!providerUser[0].lightningAddress) return c.json({ error: 'Provider has no Lightning Address configured' }, 400)

    const svcKinds = JSON.parse(providerSvc[0].kinds) as number[]
    if (!svcKinds.includes(kind)) {
      return c.json({ error: `Provider does not support kind ${kind}` }, 400)
    }

    directedProviderId = providerUser[0].id
  }

  // Merge min_zap_sats into extraParams for the Nostr event param tags
  const extraParams = { ...body.params }
  if (minZapSats) {
    extraParams.min_zap_sats = String(minZapSats)
  }

  // Merge min_zap_sats into stored params JSON
  const storedParams = { ...body.params }
  if (minZapSats) {
    storedParams.min_zap_sats = String(minZapSats)
  }
  const paramsJson = Object.keys(storedParams).length > 0 ? JSON.stringify(storedParams) : null

  const relays = (c.env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)

  const event = await buildJobRequestEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    kind,
    input,
    inputType,
    output: body.output,
    bidMsats,
    extraParams: Object.keys(extraParams).length > 0 ? extraParams : undefined,
    relays,
  })

  // Save to DB
  const jobId = generateId()
  const now = new Date()
  await db.insert(dvmJobs).values({
    id: jobId,
    userId: user.id,
    role: 'customer',
    kind,
    eventId: event.id,
    status: 'open',
    input,
    inputType,
    output: body.output || null,
    bidMsats: bidMsats || null,
    customerPubkey: event.pubkey,
    requestEventId: event.id,
    params: paramsJson,
    createdAt: now,
    updatedAt: now,
  })

  // Publish to relay + Kind 1 note + board repost
  if (c.env.NOSTR_QUEUE) {
    const kindLabel = DVM_KIND_LABELS[kind] || `kind ${kind}`
    const bidStr = bidSats > 0 ? ` (${bidSats} sats)` : ''
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    const noteEvent = await buildSignedEvent({
      privEncrypted: user.nostrPrivEncrypted!,
      iv: user.nostrPrivIv!,
      masterKey: c.env.NOSTR_MASTER_KEY!,
      kind: 1,
      content: `📡 Looking for ${kindLabel}${bidStr} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    const eventsToSend: NostrEvent[] = [event, noteEvent]
    const repost = await buildBoardRepost(db, noteEvent, c.env.NOSTR_MASTER_KEY!, relayUrl)
    if (repost) eventsToSend.push(repost)
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
  }

  // 同站直投：如果本站有注册了对应 Kind 的 Provider，直接创建 provider job
  c.executionCtx.waitUntil((async () => {
    try {
      if (directedProviderId) {
        // Directed request: only deliver to the specified provider
        const existing = await db.select({ id: dvmJobs.id }).from(dvmJobs)
          .where(and(eq(dvmJobs.requestEventId, event.id), eq(dvmJobs.userId, directedProviderId)))
          .limit(1)
        if (existing.length === 0) {
          await db.insert(dvmJobs).values({
            id: generateId(),
            userId: directedProviderId,
            role: 'provider',
            kind,
            status: 'open',
            input,
            inputType,
            output: body.output || null,
            bidMsats: bidMsats || null,
            customerPubkey: event.pubkey,
            requestEventId: event.id,
            params: paramsJson,
            createdAt: now,
            updatedAt: now,
          })
          console.log(`[DVM] Directed delivery: job ${event.id} → provider ${directedProviderId}`)
        }
      } else {
        // Broadcast: deliver to all matching providers
        const activeServices = await db
          .select({ userId: dvmServices.userId, kinds: dvmServices.kinds, totalZapReceived: dvmServices.totalZapReceived, nostrPubkey: users.nostrPubkey })
          .from(dvmServices)
          .innerJoin(users, eq(dvmServices.userId, users.id))
          .where(eq(dvmServices.active, 1))

        // Batch query report counts for all provider pubkeys
        const providerPubkeys = activeServices.map(s => s.nostrPubkey).filter((pk): pk is string => !!pk)
        const flaggedPubkeys = new Set<string>()
        if (providerPubkeys.length > 0) {
          const rcRows = await db.select({
            targetPubkey: nostrReports.targetPubkey,
            count: sql<number>`COUNT(DISTINCT reporter_pubkey)`,
          }).from(nostrReports)
            .where(inArray(nostrReports.targetPubkey, providerPubkeys))
            .groupBy(nostrReports.targetPubkey)
          for (const row of rcRows) {
            if (row.count >= REPORT_FLAG_THRESHOLD) flaggedPubkeys.add(row.targetPubkey)
          }
        }

        for (const svc of activeServices) {
          if (svc.userId === user.id) continue // 不给自己投递
          try {
            const svcKinds = JSON.parse(svc.kinds) as number[]
            if (!svcKinds.includes(kind)) continue

            // Check min_zap_sats threshold
            if (minZapSats && (svc.totalZapReceived || 0) < minZapSats) {
              console.log(`[DVM] Skipping provider ${svc.userId}: zap ${svc.totalZapReceived || 0} < required ${minZapSats}`)
              continue
            }

            // Skip flagged providers (report_count >= threshold)
            if (svc.nostrPubkey && flaggedPubkeys.has(svc.nostrPubkey)) {
              console.log(`[DVM] Skipping flagged provider ${svc.userId}`)
              continue
            }

            // 检查是否已存在（防重复）
            const existing = await db
              .select({ id: dvmJobs.id })
              .from(dvmJobs)
              .where(and(
                eq(dvmJobs.requestEventId, event.id),
                eq(dvmJobs.userId, svc.userId),
              ))
              .limit(1)
            if (existing.length > 0) continue

            await db.insert(dvmJobs).values({
              id: generateId(),
              userId: svc.userId,
              role: 'provider',
              kind,
              status: 'open',
              input,
              inputType,
              output: body.output || null,
              bidMsats: bidMsats || null,
              customerPubkey: event.pubkey,
              requestEventId: event.id,
              params: paramsJson,
              createdAt: now,
              updatedAt: now,
            })
            console.log(`[DVM] Local delivery: job ${event.id} → provider ${svc.userId}`)
          } catch {}
        }
      }
    } catch (e) {
      console.error('[DVM] Local delivery failed:', e)
    }
  })())

  return c.json({
    job_id: jobId,
    event_id: event.id,
    status: 'open',
    kind,
  }, 201)
})

// GET /api/dvm/jobs — 查看自己的任务列表
api.get('/dvm/jobs', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const role = c.req.query('role') // customer | provider
  const status = c.req.query('status') // comma-separated
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const conditions = [eq(dvmJobs.userId, user.id)]
  if (role === 'customer' || role === 'provider') {
    conditions.push(eq(dvmJobs.role, role))
  }
  if (status) {
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length > 0) {
      conditions.push(inArray(dvmJobs.status, statuses))
    }
  }

  const jobs = await db
    .select()
    .from(dvmJobs)
    .where(and(...conditions))
    .orderBy(desc(dvmJobs.createdAt))
    .limit(limit)
    .offset(offset)

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      role: j.role,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      output: j.output,
      result: j.result,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
      customer_pubkey: j.customerPubkey,
      provider_pubkey: j.providerPubkey,
      request_event_id: j.requestEventId,
      result_event_id: j.resultEventId,
      params: j.params ? JSON.parse(j.params) : null,
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    })),
    page,
    limit,
  })
})

// GET /api/dvm/jobs/:id — 任务详情（查看任意 job）
api.get('/dvm/jobs/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  // 先查自己名下的 job（包含 provider 视角）
  let job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id)))
    .limit(1)

  // 如果不是自己的，查 customer 的原始 job（公开需求）
  if (job.length === 0) {
    job = await db.select().from(dvmJobs)
      .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer')))
      .limit(1)
  }

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = job[0]
  return c.json({
    id: j.id,
    role: j.role,
    kind: j.kind,
    status: j.status,
    input: j.input,
    input_type: j.inputType,
    output: j.output,
    result: j.result,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
    price_sats: j.priceMsats ? Math.floor(j.priceMsats / 1000) : null,
    customer_pubkey: j.customerPubkey,
    provider_pubkey: j.providerPubkey,
    request_event_id: j.requestEventId,
    result_event_id: j.resultEventId,
    params: j.params ? JSON.parse(j.params) : null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  })
})

// POST /api/dvm/jobs/:id/accept — Provider: 接单（为自己创建 provider job）
api.post('/dvm/jobs/:id/accept', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  // 查 customer 的原始 job
  const customerJob = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (customerJob.length === 0) return c.json({ error: 'Job not found' }, 404)

  const cj = customerJob[0]
  if (cj.userId === user.id) return c.json({ error: 'Cannot accept your own job' }, 400)
  if (cj.status === 'cancelled') return c.json({ error: 'Job is cancelled' }, 400)
  if (cj.status === 'completed') return c.json({ error: 'Job is already completed' }, 400)

  // Check min_zap_sats threshold
  if (cj.params) {
    try {
      const jobParams = JSON.parse(cj.params)
      const minZap = jobParams.min_zap_sats ? parseInt(jobParams.min_zap_sats) : 0
      if (minZap > 0) {
        const providerSvc = await db.select({ totalZapReceived: dvmServices.totalZapReceived })
          .from(dvmServices)
          .where(and(eq(dvmServices.userId, user.id), eq(dvmServices.active, 1)))
          .limit(1)
        const zapTotal = providerSvc.length > 0 ? (providerSvc[0].totalZapReceived || 0) : 0
        if (zapTotal < minZap) {
          return c.json({ error: `This job requires at least ${minZap} sats in zap history (you have ${zapTotal})` }, 403)
        }
      }
    } catch {}
  }

  // error 状态允许重新接单，重置为 open
  if (cj.status === 'error') {
    await db.update(dvmJobs)
      .set({ status: 'open', updatedAt: new Date() })
      .where(eq(dvmJobs.id, jobId))
  }

  // 检查是否已有活跃的 provider job（open/processing）
  // Board customer job 的 requestEventId 是原始用户 event ID，eventId 是 Kind 5xxx
  // pollDvmRequests 创建的 provider job 用的是 Kind 5xxx 作为 requestEventId
  // 所以需要同时检查两个值
  const eventIdsToCheck = [cj.requestEventId, cj.eventId].filter((id): id is string => !!id)
  const existing = await db.select({ id: dvmJobs.id, status: dvmJobs.status }).from(dvmJobs)
    .where(and(
      inArray(dvmJobs.requestEventId, eventIdsToCheck),
      eq(dvmJobs.userId, user.id),
      eq(dvmJobs.role, 'provider'),
      inArray(dvmJobs.status, ['open', 'processing']),
    ))
    .limit(1)

  if (existing.length > 0) {
    return c.json({ job_id: existing[0].id, status: 'already_accepted' })
  }

  // 创建 provider job，使用 eventId（Kind 5xxx）作为 requestEventId 以保持一致
  const providerJobId = generateId()
  const now = new Date()
  await db.insert(dvmJobs).values({
    id: providerJobId,
    userId: user.id,
    role: 'provider',
    kind: cj.kind,
    status: 'open',
    input: cj.input,
    inputType: cj.inputType,
    output: cj.output,
    bidMsats: cj.bidMsats,
    customerPubkey: cj.customerPubkey,
    requestEventId: cj.eventId || cj.requestEventId,
    params: cj.params,
    createdAt: now,
    updatedAt: now,
  })

  await db.update(dvmJobs)
    .set({ status: 'processing', updatedAt: now })
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.status, 'open')))

  // Kind 1 note + board repost
  if (user.nostrPrivEncrypted && user.nostrPrivIv && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    const kindLabel = DVM_KIND_LABELS[cj.kind] || `kind ${cj.kind}`
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    const noteEvent = await buildSignedEvent({
      privEncrypted: user.nostrPrivEncrypted,
      iv: user.nostrPrivIv,
      masterKey: c.env.NOSTR_MASTER_KEY,
      kind: 1,
      content: `⚡ Accepted a ${kindLabel} job #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    const eventsToSend: NostrEvent[] = [noteEvent]
    const repost = await buildBoardRepost(db, noteEvent, c.env.NOSTR_MASTER_KEY, relayUrl)
    if (repost) eventsToSend.push(repost)
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
  }

  // Check if provider is flagged and add warning
  let warning: string | undefined
  if (user.nostrPubkey) {
    const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
      .from(nostrReports).where(eq(nostrReports.targetPubkey, user.nostrPubkey))
    if ((rc[0]?.count || 0) >= REPORT_FLAG_THRESHOLD) {
      warning = 'Your account has been flagged due to multiple reports. Some jobs may not be delivered to you.'
    }
  }

  return c.json({ job_id: providerJobId, status: 'accepted', kind: cj.kind, ...(warning ? { warning } : {}) })
})

// POST /api/dvm/jobs/:id/reject — Customer: 拒绝结果，重新开放接单
api.post('/dvm/jobs/:id/reject', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'result_available') {
    return c.json({ error: `Cannot reject job with status: ${job[0].status}` }, 400)
  }

  const body = await c.req.json().catch(() => ({}))
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null

  // 重置 customer job 为 open
  await db.update(dvmJobs)
    .set({
      status: 'open',
      result: null,
      resultEventId: null,
      providerPubkey: null,
      priceMsats: null,
      updatedAt: new Date(),
    })
    .where(eq(dvmJobs.id, jobId))

  // 把对应的 provider job 标记为 rejected（附带原因）+ 更新声誉
  if (job[0].requestEventId) {
    // Find the provider job to get the provider userId
    const providerJobs = await db.select({ id: dvmJobs.id, userId: dvmJobs.userId }).from(dvmJobs)
      .where(and(
        eq(dvmJobs.requestEventId, job[0].requestEventId),
        eq(dvmJobs.role, 'provider'),
        inArray(dvmJobs.status, ['completed', 'result_available']),
      ))

    if (providerJobs.length > 0) {
      await db.update(dvmJobs)
        .set({ status: 'rejected', result: reason, updatedAt: new Date() })
        .where(eq(dvmJobs.id, providerJobs[0].id))

      // Update provider reputation: jobsRejected++, jobsCompleted-- (rollback)
      const providerSvc = await db.select().from(dvmServices)
        .where(and(eq(dvmServices.userId, providerJobs[0].userId), eq(dvmServices.active, 1)))
        .limit(1)

      if (providerSvc.length > 0) {
        const s = providerSvc[0]
        await db.update(dvmServices).set({
          jobsCompleted: Math.max(0, (s.jobsCompleted || 0) - 1),
          jobsRejected: (s.jobsRejected || 0) + 1,
          updatedAt: new Date(),
        }).where(eq(dvmServices.id, s.id))
      }
    }
  }

  // 重新同站直投：给注册了对应 Kind 的 Provider 创建新的 provider job（排除已被拒绝的）
  const cj = job[0]
  c.executionCtx.waitUntil((async () => {
    try {
      const activeServices = await db
        .select({ userId: dvmServices.userId, kinds: dvmServices.kinds })
        .from(dvmServices)
        .where(eq(dvmServices.active, 1))

      for (const svc of activeServices) {
        if (svc.userId === user.id) continue
        try {
          const svcKinds = JSON.parse(svc.kinds) as number[]
          if (!svcKinds.includes(cj.kind)) continue

          // 排除已被拒绝的 Provider 和正在处理中的 Provider
          const existing = await db.select({ id: dvmJobs.id }).from(dvmJobs)
            .where(and(
              eq(dvmJobs.requestEventId, cj.requestEventId!),
              eq(dvmJobs.userId, svc.userId),
              eq(dvmJobs.role, 'provider'),
              inArray(dvmJobs.status, ['open', 'processing', 'rejected']),
            ))
            .limit(1)
          if (existing.length > 0) continue

          await db.insert(dvmJobs).values({
            id: generateId(),
            userId: svc.userId,
            role: 'provider',
            kind: cj.kind,
            status: 'open',
            input: cj.input,
            inputType: cj.inputType,
            output: cj.output,
            bidMsats: cj.bidMsats,
            customerPubkey: cj.customerPubkey,
            requestEventId: cj.requestEventId,
            params: cj.params,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          console.log(`[DVM] Re-delivery after reject: job ${cj.requestEventId} → provider ${svc.userId}`)
        } catch {}
      }
    } catch (e) {
      console.error('[DVM] Re-delivery after reject failed:', e)
    }
  })())

  return c.json({ ok: true, status: 'open', ...(reason ? { reason } : {}) })
})

// POST /api/dvm/jobs/:id/cancel — Customer: 取消任务
api.post('/dvm/jobs/:id/cancel', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status === 'completed' || job[0].status === 'cancelled') {
    return c.json({ error: `Cannot cancel job with status: ${job[0].status}` }, 400)
  }

  await db.update(dvmJobs)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  // Send Kind 5 deletion event for the request
  if (job[0].requestEventId && user.nostrPrivEncrypted && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', job[0].requestEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[DVM] Failed to send deletion event:', e)
      }
    })())
  }

  return c.json({ ok: true, status: 'cancelled' })
})

// POST /api/dvm/services — Provider: 注册服务
api.post('/dvm/services', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    kinds?: number[]
    description?: string
    pricing?: { min_sats?: number; max_sats?: number }
    direct_request_enabled?: boolean
  }

  if (!body.kinds || !Array.isArray(body.kinds) || body.kinds.length === 0) {
    return c.json({ error: 'kinds array is required' }, 400)
  }

  for (const k of body.kinds) {
    if (k < 5000 || k > 5999) {
      return c.json({ error: `Invalid kind ${k}: must be between 5000 and 5999` }, 400)
    }
  }

  // Enabling direct requests requires a Lightning Address
  if (body.direct_request_enabled && !user.lightningAddress) {
    return c.json({ error: 'Lightning Address is required to enable direct requests. Set it via PUT /api/me.' }, 400)
  }

  const pricingMin = body.pricing?.min_sats ? body.pricing.min_sats * 1000 : null
  const pricingMax = body.pricing?.max_sats ? body.pricing.max_sats * 1000 : null

  // Fetch existing service for reputation data
  const existing = await db.select().from(dvmServices)
    .where(and(eq(dvmServices.userId, user.id), eq(dvmServices.active, 1)))
    .limit(1)

  const reputation = existing.length > 0 ? buildReputationData(existing[0]) : undefined

  // Build NIP-89 Handler Info (Kind 31990) — one event per kind
  const handlerEvents = await buildHandlerInfoEvents({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    kinds: body.kinds,
    name: user.displayName || user.username,
    picture: user.avatarUrl || `https://robohash.org/${encodeURIComponent(user.username)}`,
    about: body.description,
    pricingMin: pricingMin || undefined,
    pricingMax: pricingMax || undefined,
    userId: user.id,
    reputation,
  })
  const handlerEvent = handlerEvents[0] // use first event ID for DB

  const now = new Date()

  let serviceId: string
  const directRequestEnabled = body.direct_request_enabled !== undefined
    ? (body.direct_request_enabled ? 1 : 0)
    : undefined
  if (existing.length > 0) {
    serviceId = existing[0].id
    const updateSet: Record<string, unknown> = {
      kinds: JSON.stringify(body.kinds),
      description: body.description || null,
      pricingMin,
      pricingMax,
      eventId: handlerEvent.id,
      updatedAt: now,
    }
    if (directRequestEnabled !== undefined) updateSet.directRequestEnabled = directRequestEnabled
    await db.update(dvmServices).set(updateSet).where(eq(dvmServices.id, serviceId))
  } else {
    serviceId = generateId()
    await db.insert(dvmServices).values({
      id: serviceId,
      userId: user.id,
      kinds: JSON.stringify(body.kinds),
      description: body.description || null,
      pricingMin,
      pricingMax,
      eventId: handlerEvent.id,
      active: 1,
      directRequestEnabled: directRequestEnabled || 0,
      createdAt: now,
      updatedAt: now,
    })
  }

  // Publish Handler Info to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: handlerEvents }))
  }

  return c.json({
    service_id: serviceId,
    event_id: handlerEvent.id,
    kinds: body.kinds,
    updated: existing.length > 0,
  }, existing.length > 0 ? 200 : 201)
})

// GET /api/dvm/services — Provider: 查看自己注册的服务
api.get('/dvm/services', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const services = await db.select().from(dvmServices)
    .where(eq(dvmServices.userId, user.id))
    .orderBy(desc(dvmServices.createdAt))

  // Report count for current user
  let reportCount = 0
  if (user.nostrPubkey) {
    const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
      .from(nostrReports).where(eq(nostrReports.targetPubkey, user.nostrPubkey))
    reportCount = rc[0]?.count || 0
  }

  return c.json({
    services: services.map(s => ({
      id: s.id,
      kinds: JSON.parse(s.kinds),
      description: s.description,
      pricing_min_sats: s.pricingMin ? Math.floor(s.pricingMin / 1000) : null,
      pricing_max_sats: s.pricingMax ? Math.floor(s.pricingMax / 1000) : null,
      active: !!s.active,
      direct_request_enabled: !!s.directRequestEnabled,
      total_zap_received_sats: s.totalZapReceived || 0,
      reputation: buildReputationData(s),
      report_count: reportCount,
      flagged: reportCount >= REPORT_FLAG_THRESHOLD,
      created_at: s.createdAt,
    })),
  })
})

// DELETE /api/dvm/services/:id — Provider: 停用服务
api.delete('/dvm/services/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const serviceId = c.req.param('id')

  const svc = await db.select({ id: dvmServices.id }).from(dvmServices)
    .where(and(eq(dvmServices.id, serviceId), eq(dvmServices.userId, user.id)))
    .limit(1)

  if (svc.length === 0) return c.json({ error: 'Service not found' }, 404)

  await db.update(dvmServices)
    .set({ active: 0, updatedAt: new Date() })
    .where(eq(dvmServices.id, serviceId))

  return c.json({ ok: true })
})

// GET /api/dvm/inbox — Provider: 查看收到的 Job Request
api.get('/dvm/inbox', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  const kindFilter = c.req.query('kind')
  const statusFilter = c.req.query('status') || 'open'
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const conditions = [eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')]
  if (kindFilter) {
    conditions.push(eq(dvmJobs.kind, parseInt(kindFilter)))
  }
  if (statusFilter) {
    const statuses = statusFilter.split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length > 0) {
      conditions.push(inArray(dvmJobs.status, statuses))
    }
  }

  const whereClause = and(...conditions)

  const [jobs, countResult] = await Promise.all([
    db
      .select()
      .from(dvmJobs)
      .where(whereClause)
      .orderBy(desc(dvmJobs.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(whereClause),
  ])

  const total = countResult[0]?.count || 0

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      input: j.input,
      input_type: j.inputType,
      output: j.output,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
      customer_pubkey: j.customerPubkey,
      request_event_id: j.requestEventId,
      params: j.params ? JSON.parse(j.params) : null,
      created_at: j.createdAt,
    })),
    meta: paginationMeta(total, page, limit),
  })
})

// POST /api/dvm/jobs/:id/feedback — Provider: 发送状态更新
api.post('/dvm/jobs/:id/feedback', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (!job[0].requestEventId || !job[0].customerPubkey) {
    return c.json({ error: 'Job missing request data' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    status?: 'processing' | 'error'
    content?: string
  }

  if (!body.status || !['processing', 'error'].includes(body.status)) {
    return c.json({ error: 'status must be "processing" or "error"' }, 400)
  }

  const feedbackEvent = await buildJobFeedbackEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    requestEventId: job[0].requestEventId!,
    customerPubkey: job[0].customerPubkey!,
    status: body.status,
    content: body.content,
  })

  await db.update(dvmJobs)
    .set({ status: body.status === 'error' ? 'error' : 'processing', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [feedbackEvent] }))
  }

  return c.json({ ok: true, event_id: feedbackEvent.id })
})

// POST /api/dvm/jobs/:id/result — Provider: 提交结果
api.post('/dvm/jobs/:id/result', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (!job[0].requestEventId || !job[0].customerPubkey) {
    return c.json({ error: 'Job missing request data' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    content?: string
    amount_sats?: number
    bolt11?: string
  }

  if (!body.content) {
    return c.json({ error: 'content is required' }, 400)
  }

  const amountSats = body.amount_sats || 0
  const amountMsats = amountSats ? amountSats * 1000 : undefined

  // Provider can include their own bolt11 invoice for payment
  const bolt11 = body.bolt11 || undefined

  const resultEvent = await buildJobResultEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY!,
    requestKind: job[0].kind,
    requestEventId: job[0].requestEventId!,
    customerPubkey: job[0].customerPubkey!,
    content: body.content,
    amountMsats: amountMsats,
    bolt11,
  })

  const now = new Date()

  // Update provider job
  await db.update(dvmJobs)
    .set({
      status: 'completed',
      result: body.content,
      resultEventId: resultEvent.id,
      eventId: resultEvent.id,
      priceMsats: amountMsats || null,
      bolt11: bolt11 || null,
      updatedAt: now,
    })
    .where(eq(dvmJobs.id, jobId))

  // If customer is also on this site, update their job directly
  // Provider's requestEventId may be the Kind 5xxx event ID (from pollDvmRequests)
  // Board customer jobs store Kind 5xxx as eventId, original user event as requestEventId
  // So we check both requestEventId and eventId on customer side
  if (job[0].requestEventId) {
    const customerJob = await db.select({ id: dvmJobs.id }).from(dvmJobs)
      .where(and(
        or(
          eq(dvmJobs.requestEventId, job[0].requestEventId),
          eq(dvmJobs.eventId, job[0].requestEventId),
        ),
        eq(dvmJobs.role, 'customer'),
      ))
      .limit(1)

    if (customerJob.length > 0) {
      await db.update(dvmJobs)
        .set({
          status: 'result_available',
          result: body.content,
          providerPubkey: user.nostrPubkey,
          resultEventId: resultEvent.id,
          priceMsats: amountMsats || null,
          updatedAt: now,
        })
        .where(eq(dvmJobs.id, customerJob[0].id))
    }
  }

  // Update provider reputation stats
  const svc = await db.select().from(dvmServices)
    .where(and(eq(dvmServices.userId, user.id), eq(dvmServices.active, 1)))
    .limit(1)

  if (svc.length > 0) {
    const s = svc[0]
    const prevCompleted = s.jobsCompleted || 0
    const newCompleted = prevCompleted + 1

    // Calculate response time: from job accepted_at (or created_at) to now
    const jobCreatedMs = job[0].createdAt.getTime()
    const responseMs = now.getTime() - jobCreatedMs
    const prevAvg = s.avgResponseMs || 0
    const newAvgResponseMs = prevCompleted > 0
      ? Math.round((prevAvg * prevCompleted + responseMs) / newCompleted)
      : responseMs

    await db.update(dvmServices).set({
      jobsCompleted: newCompleted,
      totalEarnedMsats: (s.totalEarnedMsats || 0) + (amountMsats || 0),
      avgResponseMs: newAvgResponseMs,
      lastJobAt: now,
      updatedAt: now,
    }).where(eq(dvmServices.id, s.id))
  }

  // Publish result to relay + Kind 1 note + board repost + updated Kind 31990
  if (c.env.NOSTR_QUEUE) {
    const kindLabel = DVM_KIND_LABELS[job[0].kind] || `kind ${job[0].kind}`
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    const noteEvent = await buildSignedEvent({
      privEncrypted: user.nostrPrivEncrypted!,
      iv: user.nostrPrivIv!,
      masterKey: c.env.NOSTR_MASTER_KEY!,
      kind: 1,
      content: `✅ Completed a ${kindLabel} job #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    const eventsToSend: NostrEvent[] = [resultEvent, noteEvent]
    const repost = await buildBoardRepost(db, noteEvent, c.env.NOSTR_MASTER_KEY!, relayUrl)
    if (repost) eventsToSend.push(repost)

    // Republish updated Kind 31990 with latest reputation
    if (svc.length > 0) {
      const s = svc[0]
      const updatedSvc = await db.select().from(dvmServices).where(eq(dvmServices.id, s.id)).limit(1)
      if (updatedSvc.length > 0) {
        const handlerEvts = await buildHandlerInfoEvents({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kinds: JSON.parse(updatedSvc[0].kinds),
          name: user.displayName || user.username,
          picture: user.avatarUrl || `https://robohash.org/${encodeURIComponent(user.username)}`,
          about: updatedSvc[0].description || undefined,
          pricingMin: updatedSvc[0].pricingMin || undefined,
          pricingMax: updatedSvc[0].pricingMax || undefined,
          userId: user.id,
          reputation: buildReputationData(updatedSvc[0]),
        })
        eventsToSend.push(...handlerEvts)
      }
    }

    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
  }

  return c.json({ ok: true, event_id: resultEvent.id }, 201)
})


// POST /api/dvm/jobs/:id/complete — Customer confirms result, pay provider via NWC
api.post('/dvm/jobs/:id/complete', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'result_available') {
    return c.json({ error: `Cannot complete job with status: ${job[0].status}` }, 400)
  }

  const bidSats = job[0].bidMsats ? Math.floor(job[0].bidMsats / 1000) : 0
  const priceSats = job[0].priceMsats ? Math.floor(job[0].priceMsats / 1000) : 0
  const totalPaymentSats = priceSats > 0 ? Math.min(priceSats, bidSats || priceSats) : bidSats

  // Calculate platform fee
  const feePercent = parseFloat(c.env.PLATFORM_FEE_PERCENT || '0')
  const platformAddress = c.env.PLATFORM_LIGHTNING_ADDRESS || ''
  const feeSats = (feePercent > 0 && platformAddress) ? Math.max(1, Math.floor(totalPaymentSats * feePercent / 100)) : 0
  const providerSats = totalPaymentSats - feeSats

  // Payment via NWC if amount > 0
  let paymentResult: { preimage?: string; paid_sats?: number; fee_sats?: number } = {}

  if (totalPaymentSats > 0) {
    // Customer must have NWC enabled
    if (!user.nwcEnabled || !user.nwcEncrypted || !user.nwcIv || !c.env.NOSTR_MASTER_KEY) {
      return c.json({ error: 'NWC wallet not configured. Connect a wallet via PUT /api/me to pay for jobs.' }, 400)
    }

    const nwcUri = await decryptNwcUri(user.nwcEncrypted, user.nwcIv, c.env.NOSTR_MASTER_KEY)
    const nwcParsed = parseNwcUri(nwcUri)

    // Step 1: Pay platform fee
    if (feeSats > 0) {
      try {
        await resolveAndPayLightningAddress(nwcParsed, platformAddress, feeSats)
        console.log(`[DVM] Platform fee: ${feeSats} sats → ${platformAddress}`)
      } catch (e) {
        console.error('[DVM] Platform fee payment failed:', e)
        return c.json({
          error: 'Platform fee payment failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    }

    // Step 2: Pay provider
    if (job[0].bolt11) {
      try {
        const result = await nwcPayInvoice(nwcParsed, job[0].bolt11)
        paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats }
      } catch (e) {
        return c.json({
          error: 'NWC payment failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    } else {
      let providerLightningAddress: string | null = null

      if (job[0].requestEventId) {
        const providerJob = await db.select({ userId: dvmJobs.userId }).from(dvmJobs)
          .where(and(
            eq(dvmJobs.requestEventId, job[0].requestEventId),
            eq(dvmJobs.role, 'provider'),
            eq(dvmJobs.status, 'completed'),
          ))
          .limit(1)
        if (providerJob.length > 0) {
          const providerUser = await db.select({ lightningAddress: users.lightningAddress }).from(users)
            .where(eq(users.id, providerJob[0].userId)).limit(1)
          if (providerUser.length > 0) providerLightningAddress = providerUser[0].lightningAddress
        }
      }
      if (!providerLightningAddress && job[0].providerPubkey) {
        const localUser = await db.select({ lightningAddress: users.lightningAddress }).from(users)
          .where(eq(users.nostrPubkey, job[0].providerPubkey)).limit(1)
        if (localUser.length > 0) providerLightningAddress = localUser[0].lightningAddress
      }

      if (!providerLightningAddress) {
        return c.json({
          error: 'Cannot pay: provider has no Lightning invoice or Lightning Address',
        }, 400)
      }

      try {
        const result = await resolveAndPayLightningAddress(nwcParsed, providerLightningAddress, providerSats)
        paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats }
      } catch (e) {
        return c.json({
          error: 'NWC payment to Lightning Address failed',
          detail: e instanceof Error ? e.message : 'Unknown error',
        }, 502)
      }
    }
  }

  // Mark customer job as completed
  await db.update(dvmJobs)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(dvmJobs.id, jobId))

  // Kind 1 note + approval
  if (user.nostrPrivEncrypted && user.nostrPrivIv && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    const kindLabel = DVM_KIND_LABELS[job[0].kind] || `kind ${job[0].kind}`
    const paidStr = paymentResult.paid_sats ? ` — paid ${paymentResult.paid_sats} sats ⚡` : ''
    const relayUrl = (c.env.NOSTR_RELAYS || '').split(',')[0]?.trim() || ''
    const noteEvent = await buildSignedEvent({
      privEncrypted: user.nostrPrivEncrypted,
      iv: user.nostrPrivIv,
      masterKey: c.env.NOSTR_MASTER_KEY,
      kind: 1,
      content: `🤝 Job done: ${kindLabel}${paidStr} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    const eventsToSend: NostrEvent[] = [noteEvent]
    const repost = await buildBoardRepost(db, noteEvent, c.env.NOSTR_MASTER_KEY, relayUrl)
    if (repost) eventsToSend.push(repost)
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
  }

  return c.json({
    ok: true,
    ...(paymentResult.paid_sats ? { paid_sats: paymentResult.paid_sats, provider_sats: providerSats, fee_sats: paymentResult.fee_sats } : {}),
  })
})


export default api
