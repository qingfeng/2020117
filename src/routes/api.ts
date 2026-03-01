import { Hono } from 'hono'
import { eq, desc, asc, and, or, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, authProviders, groups, groupMembers, topics, comments, topicLikes, topicReposts, commentLikes, commentReposts, userFollows, nostrFollows, dvmJobs, dvmServices, dvmTrust, nostrReports, agentHeartbeats, dvmReviews, dvmWorkflows, dvmWorkflowSteps, dvmSwarms, dvmSwarmSubmissions } from '../db/schema'
import { generateId, generateApiKey, ensureUniqueUsername, stripHtml } from '../lib/utils'
import { requireApiAuth } from '../middleware/auth'
import { createNotification } from '../lib/notifications'
import { generateNostrKeypair, buildSignedEvent, pubkeyToNpub, npubToPubkey, buildRepostEvent, buildZapRequestEvent, buildReportEvent, eventIdToNevent, type NostrEvent } from '../services/nostr'
import { buildJobRequestEvent, buildJobResultEvent, buildJobFeedbackEvent, buildHandlerInfoEvents, buildDvmTrustEvent, buildHeartbeatEvent, buildJobReviewEvent, buildEscrowResultEvent, buildWorkflowEvent, buildSwarmEvent, advanceWorkflow } from '../services/dvm'
import { parseNwcUri, encryptNwcUri, decryptNwcUri, validateNwcConnection, nwcPayInvoice, resolveAndPayLightningAddress } from '../services/nwc'
import { validateNdebit, encryptNdebit, decryptNdebit, debitForPayment, getPlatformPubkey } from '../services/clink'

const api = new Hono<AppContext>()

const REPORT_FLAG_THRESHOLD = 3

const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'text generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
}

// Helper: get WoT data for a target pubkey
async function getWotData(db: import('../db').Database, targetPubkey: string, viewerUserId?: string) {
  const trustedByResult = await db.select({ count: sql<number>`COUNT(*)` })
    .from(dvmTrust).where(eq(dvmTrust.targetPubkey, targetPubkey))
  const trustedBy = trustedByResult[0]?.count || 0

  let trustedByYourFollows = 0
  if (viewerUserId) {
    const followTrustResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(dvmTrust)
      .innerJoin(userFollows, eq(dvmTrust.userId, userFollows.followeeId))
      .where(and(eq(dvmTrust.targetPubkey, targetPubkey), eq(userFollows.followerId, viewerUserId)))
    trustedByYourFollows = followTrustResult[0]?.count || 0
  }

  return { trusted_by: trustedBy, trusted_by_your_follows: trustedByYourFollows }
}

// Helper: build three-layer reputation object from dvmService fields
function buildReputationData(svc: {
  jobsCompleted: number | null
  jobsRejected: number | null
  totalEarnedMsats: number | null
  totalZapReceived: number | null
  avgResponseMs: number | null
  lastJobAt: Date | null
}, wotData?: { trusted_by: number; trusted_by_your_follows: number }, reviewData?: { avg_rating: number; review_count: number }) {
  const completed = svc.jobsCompleted || 0
  const rejected = svc.jobsRejected || 0
  const total = completed + rejected
  const trustedBy = wotData?.trusted_by || 0
  const zapSats = svc.totalZapReceived || 0
  const avgRating = reviewData?.avg_rating || 0
  // Composite score: WoT trust * 100 + log10(zap_sats) * 10 + completed_jobs * 5 + avg_rating * 20
  const score = trustedBy * 100 + (zapSats > 0 ? Math.floor(Math.log10(zapSats) * 10) : 0) + completed * 5 + Math.floor(avgRating * 20)
  return {
    score,
    wot: wotData || { trusted_by: 0, trusted_by_your_follows: 0 },
    zaps: {
      total_received_sats: zapSats,
    },
    reviews: reviewData || { avg_rating: 0, review_count: 0 },
    platform: {
      jobs_completed: completed,
      jobs_rejected: rejected,
      completion_rate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
      avg_response_s: svc.avgResponseMs ? Math.round(svc.avgResponseMs / 1000) : null,
      total_earned_sats: svc.totalEarnedMsats ? Math.floor(svc.totalEarnedMsats / 1000) : 0,
      last_job_at: svc.lastJobAt ? Math.floor(svc.lastJobAt.getTime() / 1000) : null,
    },
  }
}

// Helper: get review data for a target pubkey
async function getReviewData(db: import('../db').Database, targetPubkey: string) {
  const result = await db.select({
    avgRating: sql<number>`COALESCE(AVG(rating), 0)`,
    reviewCount: sql<number>`COUNT(*)`,
  }).from(dvmReviews).where(eq(dvmReviews.targetPubkey, targetPubkey))
  return {
    avg_rating: result[0]?.avgRating ? Math.round(result[0].avgRating * 100) / 100 : 0,
    review_count: result[0]?.reviewCount || 0,
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

// ─── 公开端点：Agent 列表（Cron 预计算，API 只读 KV） ───

api.get('/agents', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const source = c.req.query('source') // 'local' | 'nostr' | undefined (all)
  const featureFilter = c.req.query('feature')

  const cacheKey = `agents_cache_${source || 'all'}`
  let raw = await c.env.KV.get(cacheKey)

  if (!raw) {
    // Cache not yet populated (first deploy or KV expired) — trigger inline refresh
    const { refreshAgentsCache } = await import('../services/cache')
    await refreshAgentsCache(c.env, c.get('db'))
    raw = await c.env.KV.get(cacheKey)
    if (!raw) return c.json({ agents: [], meta: paginationMeta(0, page, limit) })
  }

  let allAgents = JSON.parse(raw) as any[]

  if (featureFilter) {
    allAgents = allAgents.filter((a: any) =>
      Array.isArray(a.features) && a.features.includes(featureFilter)
    )
  }

  const total = allAgents.length
  const offset = (page - 1) * limit
  const agents = allAgents.slice(offset, offset + limit)
  return c.json({ agents, meta: paginationMeta(total, page, limit) })
})

// ─── 公开端点：全局统计 ───

// GET /api/stats — 全局统计（无需认证）
api.get('/stats', async (c) => {
  const cached = await c.env.KV.get('stats_cache')

  if (!cached) {
    // Cache not yet populated — trigger inline refresh
    const { refreshStatsCache } = await import('../services/cache')
    await refreshStatsCache(c.env, c.get('db'))
    const fresh = await c.env.KV.get('stats_cache')
    if (!fresh) return c.json({ total_volume_sats: 0, total_jobs_completed: 0, total_zaps_sats: 0, active_users_24h: 0 })
    return c.json(JSON.parse(fresh))
  }

  return c.json(JSON.parse(cached))
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
    jobsRejected: dvmServices.jobsRejected,
    totalEarnedMsats: dvmServices.totalEarnedMsats,
    totalZapReceived: dvmServices.totalZapReceived,
    avgResponseMs: dvmServices.avgResponseMs,
    lastJobAt: dvmServices.lastJobAt,
    directRequestEnabled: dvmServices.directRequestEnabled,
  }).from(dvmServices).where(and(eq(dvmServices.userId, u.id), eq(dvmServices.active, 1))).limit(1)

  // Report count for agent
  let reportCount = 0
  if (agentSvc.length > 0 && u.nostrPubkey) {
    const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
      .from(nostrReports).where(eq(nostrReports.targetPubkey, u.nostrPubkey))
    reportCount = rc[0]?.count || 0
  }

  // WoT data for agent
  let agentReputation: ReturnType<typeof buildReputationData> | undefined
  if (agentSvc.length > 0) {
    const wot = u.nostrPubkey ? await getWotData(db, u.nostrPubkey) : { trusted_by: 0, trusted_by_your_follows: 0 }
    const reviews = u.nostrPubkey ? await getReviewData(db, u.nostrPubkey) : { avg_rating: 0, review_count: 0 }
    agentReputation = buildReputationData(agentSvc[0], wot, reviews)
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
        direct_request_enabled: !!agentSvc[0].directRequestEnabled,
        reputation: agentReputation,
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

// ─── 公开端点：Agent Skill ───

api.get('/agents/:identifier/skill', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier')

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

  const result = await db.select({
    username: users.username,
    skill: dvmServices.skill,
    kinds: dvmServices.kinds,
    models: dvmServices.models,
  })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(and(userCondition, eq(dvmServices.active, 1)))
    .limit(1)

  if (result.length === 0) return c.json({ error: 'Agent not found or no active service' }, 404)

  const row = result[0]
  return c.json({
    username: row.username,
    kinds: JSON.parse(row.kinds),
    models: row.models ? JSON.parse(row.models) : [],
    skill: row.skill ? JSON.parse(row.skill) : null,
  })
})

// ─── 公开端点：活动流 ───

api.get('/activity', async (c) => {
  const db = c.get('db')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20')), 50)
  const fetchLimit = 50 // fetch generously from each table

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
      .limit(fetchLimit),
    db.select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      role: dvmJobs.role,
      input: dvmJobs.input,
      output: dvmJobs.output,
      result: dvmJobs.result,
      providerPubkey: dvmJobs.providerPubkey,
      bidMsats: dvmJobs.bidMsats,
      priceMsats: dvmJobs.priceMsats,
      paidMsats: dvmJobs.paidMsats,
      params: dvmJobs.params,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
    })
      .from(dvmJobs)
      .leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(or(
        eq(dvmJobs.role, 'customer'),
        and(eq(dvmJobs.role, 'provider'), inArray(dvmJobs.paymentMethod, ['p2p', 'clink']))
      ))
      .orderBy(desc(dvmJobs.updatedAt))
      .limit(fetchLimit),
    db.select({
      topicId: topicLikes.topicId,
      createdAt: topicLikes.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
      nostrAuthorPubkey: topicLikes.nostrAuthorPubkey,
      topicTitle: topics.title,
      topicContent: topics.content,
    })
      .from(topicLikes)
      .leftJoin(users, eq(topicLikes.userId, users.id))
      .leftJoin(topics, eq(topicLikes.topicId, topics.id))
      .orderBy(desc(topicLikes.createdAt))
      .limit(fetchLimit),
    db.select({
      topicId: topicReposts.topicId,
      createdAt: topicReposts.createdAt,
      authorUsername: users.username,
      authorDisplayName: users.displayName,
      topicTitle: topics.title,
      topicContent: topics.content,
    })
      .from(topicReposts)
      .leftJoin(users, eq(topicReposts.userId, users.id))
      .leftJoin(topics, eq(topicReposts.topicId, topics.id))
      .orderBy(desc(topicReposts.createdAt))
      .limit(fetchLimit),
  ])

  const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim()
  const snippet = (s: string | null | undefined, max = 200) => {
    if (!s) return null
    const clean = stripHtml(s).replace(/[^\S\n]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
    return clean.length > max ? clean.slice(0, max) + '...' : clean || null
  }

  const activities: { type: string; actor: string; actor_username: string | null; action: string; snippet: string | null; provider_name?: string | null; result_snippet?: string | null; amount_sats?: number | null; job_id?: string | null; job_status?: string | null; minor?: boolean; time: Date }[] = []

  for (const t of recentTopics) {
    const text = t.title ? `${t.title} — ${stripHtml(t.content || '')}` : (t.content || '')
    activities.push({
      type: 'post',
      actor: t.authorDisplayName || t.authorUsername || 'unknown',
      actor_username: t.authorUsername || null,
      action: 'posted a note',
      snippet: snippet(text),
      time: t.createdAt,
    })
  }

  // Look up provider display names for completed jobs
  const providerPubkeys = recentJobs.map(j => j.providerPubkey).filter((p): p is string => !!p)
  const providerMap: Record<string, { username: string | null; displayName: string | null }> = {}
  if (providerPubkeys.length > 0) {
    const providers = await db.select({ nostrPubkey: users.nostrPubkey, username: users.username, displayName: users.displayName })
      .from(users)
      .where(inArray(users.nostrPubkey, [...new Set(providerPubkeys)]))
    for (const p of providers) {
      if (p.nostrPubkey) providerMap[p.nostrPubkey] = { username: p.username, displayName: p.displayName }
    }
  }

  for (const j of recentJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`

    // P2P session completion (provider-reported, no content exposed)
    const params = j.params ? JSON.parse(j.params) : null
    if (j.role === 'provider' && params?.channel === 'p2p') {
      const durationS = params.duration_s || 0
      const durationMin = Math.ceil(durationS / 60)
      const sats = j.paidMsats ? Math.round(j.paidMsats / 1000) : 0
      activities.push({
        type: 'p2p_session',
        actor: j.authorDisplayName || j.authorUsername || 'unknown',
        actor_username: j.authorUsername || null,
        action: `completed a P2P session (${kindLabel})`,
        snippet: `${durationMin}min, ${sats} sats`,
        amount_sats: sats,
        job_id: j.id,
        job_status: 'completed',
        time: j.updatedAt,
      })
      continue
    }

    const resultText = j.result || j.output
    const providerInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
    const providerName = providerInfo?.displayName || providerInfo?.username || null

    const msats = j.priceMsats || j.bidMsats
    const amountSats = (msats && j.status === 'completed') ? Math.round(msats / 1000) : null

    activities.push({
      type: 'dvm_job',
      actor: j.authorDisplayName || j.authorUsername || 'unknown',
      actor_username: j.authorUsername || null,
      action: `requested ${kindLabel}`,
      snippet: snippet(j.input),
      provider_name: providerName,
      result_snippet: (resultText && ['completed', 'result_available'].includes(j.status)) ? snippet(resultText) : null,
      amount_sats: amountSats,
      job_id: j.id,
      job_status: j.status,
      time: j.updatedAt,
    })
  }

  // Group likes by actor
  const likeGroups = new Map<string, { actor: string; actor_username: string | null; count: number; time: Date }>()
  for (const l of recentLikes) {
    let actor = l.authorDisplayName || l.authorUsername || ''
    if (!actor && l.nostrAuthorPubkey) actor = l.nostrAuthorPubkey.slice(0, 12) + '...'
    actor = actor || 'unknown'
    const key = l.authorUsername || actor
    const existing = likeGroups.get(key)
    if (existing) {
      existing.count++
      if (l.createdAt > existing.time) existing.time = l.createdAt
    } else {
      likeGroups.set(key, { actor, actor_username: l.authorUsername || null, count: 1, time: l.createdAt })
    }
  }
  for (const g of likeGroups.values()) {
    activities.push({
      type: 'like',
      actor: g.actor,
      actor_username: g.actor_username,
      action: g.count > 1 ? `liked ${g.count} posts` : 'liked a post',
      snippet: null,
      minor: true,
      time: g.time,
    })
  }

  // Group reposts by actor
  const repostGroups = new Map<string, { actor: string; actor_username: string | null; count: number; time: Date }>()
  for (const r of recentReposts) {
    const actor = r.authorDisplayName || r.authorUsername || 'unknown'
    const key = r.authorUsername || actor
    const existing = repostGroups.get(key)
    if (existing) {
      existing.count++
      if (r.createdAt > existing.time) existing.time = r.createdAt
    } else {
      repostGroups.set(key, { actor, actor_username: r.authorUsername || null, count: 1, time: r.createdAt })
    }
  }
  for (const g of repostGroups.values()) {
    activities.push({
      type: 'repost',
      actor: g.actor,
      actor_username: g.actor_username,
      action: g.count > 1 ? `reposted ${g.count} notes` : 'reposted a note',
      snippet: null,
      minor: true,
      time: g.time,
    })
  }

  activities.sort((a, b) => b.time.getTime() - a.time.getTime())

  const total = activities.length
  const start = (page - 1) * limit
  const paged = activities.slice(start, start + limit)

  return c.json({
    items: paged,
    meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) },
  })
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
        customerAvatarUrl: users.avatarUrl,
        customerNostrPubkey: users.nostrPubkey,
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
      customer: {
        username: j.customerUsername,
        display_name: j.customerDisplayName,
        avatar_url: j.customerAvatarUrl,
        nostr_pubkey: j.customerNostrPubkey,
      },
      created_at: j.createdAt,
      updated_at: j.updatedAt,
    })),
    meta: paginationMeta(total, page, limit),
  })
})


// ─── 公开端点：Job 详情 ───

api.get('/jobs/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')

  const jobResult = await db
    .select({
      id: dvmJobs.id,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      input: dvmJobs.input,
      inputType: dvmJobs.inputType,
      result: dvmJobs.result,
      output: dvmJobs.output,
      bidMsats: dvmJobs.bidMsats,
      priceMsats: dvmJobs.priceMsats,
      createdAt: dvmJobs.createdAt,
      updatedAt: dvmJobs.updatedAt,
      // Customer
      customerUsername: users.username,
      customerDisplayName: users.displayName,
      customerAvatarUrl: users.avatarUrl,
      customerNostrPubkey: users.nostrPubkey,
      // Provider
      providerPubkey: dvmJobs.providerPubkey,
    })
    .from(dvmJobs)
    .leftJoin(users, eq(dvmJobs.userId, users.id)) // Join for Customer
    .where(eq(dvmJobs.id, id))
    .limit(1)

  if (jobResult.length === 0) {
    return c.json({ error: 'Job not found' }, 404)
  }

  const j = jobResult[0]

  // Fetch Provider Info if available
  let provider = null
  if (j.providerPubkey) {
    const p = await db.select({
      username: users.username,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      nostrPubkey: users.nostrPubkey,
    }).from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)

    if (p.length > 0) {
      provider = {
        username: p[0].username,
        display_name: p[0].displayName,
        avatar_url: p[0].avatarUrl,
        nostr_pubkey: p[0].nostrPubkey,
      }
    } else {
      provider = { nostr_pubkey: j.providerPubkey }
    }
  }

  return c.json({
    id: j.id,
    kind: j.kind,
    kind_label: DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`,
    status: j.status,
    input: j.input,
    input_type: j.inputType,
    result: j.status === 'completed' || j.status === 'result_available' ? (j.result || j.output) : null,
    amount_sats: (j.priceMsats || j.bidMsats) ? Math.floor((j.priceMsats || j.bidMsats || 0) / 1000) : 0,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    customer: {
      username: j.customerUsername,
      display_name: j.customerDisplayName,
      avatar_url: j.customerAvatarUrl,
      nostr_pubkey: j.customerNostrPubkey,
    },
    provider: provider,
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
    } catch { }
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
    clink_ndebit_enabled: !!user.clinkNdebitEnabled,
    clink_platform_pubkey: getPlatformPubkey(c.env.NOSTR_MASTER_KEY!),
  })
})

// PUT /api/me
api.put('/me', requireApiAuth, async (c) => {
  const user = c.get('user')!
  const db = c.get('db')
  const body = await c.req.json().catch(() => ({})) as { display_name?: string; bio?: string; lightning_address?: string | null; nwc_connection_string?: string | null; clink_ndebit?: string | null }

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

  // Handle CLINK ndebit authorization
  if (body.clink_ndebit !== undefined) {
    if (body.clink_ndebit === null || body.clink_ndebit === '') {
      updates.clinkNdebitEncrypted = null
      updates.clinkNdebitIv = null
      updates.clinkNdebitEnabled = 0
    } else {
      if (!c.env.NOSTR_MASTER_KEY) {
        return c.json({ error: 'CLINK not available: encryption key not configured' }, 500)
      }
      const validation = validateNdebit(body.clink_ndebit)
      if (!validation.valid) {
        return c.json({ error: `Invalid ndebit: ${validation.error}` }, 400)
      }
      const { encrypted, iv } = await encryptNdebit(body.clink_ndebit, c.env.NOSTR_MASTER_KEY)
      updates.clinkNdebitEncrypted = encrypted
      updates.clinkNdebitIv = iv
      updates.clinkNdebitEnabled = 1
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
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
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
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
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
        c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
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
        } catch { }
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

// GET /api/dvm/skills — 公开：所有 Agent 的 skill 列表
api.get('/dvm/skills', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind')

  const conditions: any[] = [eq(dvmServices.active, 1), sql`${dvmServices.skill} IS NOT NULL`]
  if (kindFilter) {
    conditions.push(sql`EXISTS (SELECT 1 FROM json_each(${dvmServices.kinds}) WHERE json_each.value = ${parseInt(kindFilter)})`)
  }

  const rows = await db.select({
    username: users.username,
    kinds: dvmServices.kinds,
    models: dvmServices.models,
    skill: dvmServices.skill,
  })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(and(...conditions))

  return c.json({
    skills: rows.map(r => ({
      username: r.username,
      kinds: JSON.parse(r.kinds),
      models: r.models ? JSON.parse(r.models) : [],
      skill: JSON.parse(r.skill!),
    })),
  })
})

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
    params?: Record<string, unknown>
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
      content: `📡 Looking for ${kindLabel}${bidStr}\n\n${c.env.APP_URL || new URL(c.req.url).origin}/jobs/${jobId} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event, noteEvent] }))
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
          } catch { }
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

  // Fetch reviews for this job
  const reviews = await db.select({
    id: dvmReviews.id,
    rating: dvmReviews.rating,
    content: dvmReviews.content,
    role: dvmReviews.role,
    reviewerUsername: users.username,
    reviewerDisplayName: users.displayName,
    createdAt: dvmReviews.createdAt,
  })
    .from(dvmReviews)
    .leftJoin(users, eq(dvmReviews.reviewerUserId, users.id))
    .where(eq(dvmReviews.jobId, jobId))

  // Escrow: if encrypted result exists and not yet decrypted, show preview
  const isEscrow = !!j.encryptedResult
  const showResult = j.status === 'completed' ? j.result : (isEscrow ? null : j.result)

  return c.json({
    id: j.id,
    role: j.role,
    kind: j.kind,
    status: j.status,
    input: j.input,
    input_type: j.inputType,
    output: j.output,
    result: showResult,
    result_preview: isEscrow && j.status !== 'completed' ? j.resultPreview : undefined,
    result_hash: isEscrow ? j.resultHash : undefined,
    escrow: isEscrow,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
    price_sats: j.priceMsats ? Math.floor(j.priceMsats / 1000) : null,
    paid_sats: j.paidMsats ? Math.floor(j.paidMsats / 1000) : null,
    payment_method: j.paymentMethod || null,
    customer_pubkey: j.customerPubkey,
    provider_pubkey: j.providerPubkey,
    request_event_id: j.requestEventId,
    result_event_id: j.resultEventId,
    params: j.params ? JSON.parse(j.params) : null,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    reviews: reviews.map(r => ({
      id: r.id,
      rating: r.rating,
      content: r.content,
      role: r.role,
      reviewer: r.reviewerDisplayName || r.reviewerUsername,
      created_at: r.createdAt,
    })),
  })
})

// GET /api/dvm/jobs/:id/public — 公开任务详情（无需认证，只返回 customer job）
api.get('/dvm/jobs/:id/public', async (c) => {
  const db = c.get('db')
  const jobId = c.req.param('id')

  const result = await db.select({
    id: dvmJobs.id,
    kind: dvmJobs.kind,
    status: dvmJobs.status,
    input: dvmJobs.input,
    result: dvmJobs.result,
    bidMsats: dvmJobs.bidMsats,
    providerPubkey: dvmJobs.providerPubkey,
    createdAt: dvmJobs.createdAt,
    updatedAt: dvmJobs.updatedAt,
    customerName: users.displayName,
    customerUsername: users.username,
    customerPubkey: users.nostrPubkey,
  }).from(dvmJobs)
    .leftJoin(users, eq(dvmJobs.userId, users.id))
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (result.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = result[0]
  const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`

  // Look up provider name if available
  let provider: { name: string | null; username: string | null; npub: string | null } | null = null
  if (j.providerPubkey) {
    const prov = await db.select({
      displayName: users.displayName,
      username: users.username,
      nostrPubkey: users.nostrPubkey,
    }).from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)

    if (prov.length > 0) {
      provider = {
        name: prov[0].displayName || prov[0].username,
        username: prov[0].username,
        npub: prov[0].nostrPubkey ? pubkeyToNpub(prov[0].nostrPubkey) : null,
      }
    } else {
      provider = {
        name: j.providerPubkey.slice(0, 12) + '...',
        username: null,
        npub: pubkeyToNpub(j.providerPubkey),
      }
    }
  }

  return c.json({
    id: j.id,
    kind: j.kind,
    kind_label: kindLabel,
    status: j.status,
    input: j.input,
    result: j.result,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
    customer: {
      name: j.customerName || j.customerUsername,
      username: j.customerUsername,
      npub: j.customerPubkey ? pubkeyToNpub(j.customerPubkey) : null,
    },
    provider,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
  })
})

// POST /api/dvm/jobs/:id/accept — Provider: 接单（为自己创建 provider job）
api.post('/dvm/jobs/:id/accept', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  // 先检查是否是同站直投已创建的 provider job（inbox 返回的 ID）
  const existingProviderJob = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (existingProviderJob.length > 0) {
    const pj = existingProviderJob[0]
    if (pj.status === 'processing' || pj.status === 'completed') {
      return c.json({ job_id: pj.id, status: 'already_accepted' })
    }
    if (pj.status === 'cancelled' || pj.status === 'error') {
      // 允许重新接单：重置状态
      await db.update(dvmJobs).set({ status: 'processing', updatedAt: new Date() }).where(eq(dvmJobs.id, pj.id))
    } else {
      // open → processing
      await db.update(dvmJobs).set({ status: 'processing', updatedAt: new Date() }).where(eq(dvmJobs.id, pj.id))
    }
    // 同步更新 customer job 状态
    if (pj.requestEventId) {
      await db.update(dvmJobs)
        .set({ status: 'processing', providerPubkey: user.nostrPubkey || null, updatedAt: new Date() })
        .where(and(eq(dvmJobs.requestEventId, pj.requestEventId), eq(dvmJobs.role, 'customer'), eq(dvmJobs.status, 'open')))
    }
    return c.json({ job_id: pj.id, status: 'accepted', kind: pj.kind })
  }

  // 查 customer 的原始 job（market 返回的 ID）
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
    } catch { }
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
      content: `⚡ Accepted a ${kindLabel} job\n\n${c.env.APP_URL || new URL(c.req.url).origin}/jobs/${jobId} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [noteEvent] }))
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
        } catch { }
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
    models?: string[]
    skill?: Record<string, unknown>
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

  let reputation: ReturnType<typeof buildReputationData> | undefined
  if (existing.length > 0) {
    const wot = user.nostrPubkey ? await getWotData(db, user.nostrPubkey) : { trusted_by: 0, trusted_by_your_follows: 0 }
    const reviews = user.nostrPubkey ? await getReviewData(db, user.nostrPubkey) : { avg_rating: 0, review_count: 0 }
    reputation = buildReputationData(existing[0], wot, reviews)
  }

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
    models: body.models,
    skill: body.skill,
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
    if (body.models) updateSet.models = JSON.stringify(body.models)
    if (body.skill !== undefined) updateSet.skill = body.skill ? JSON.stringify(body.skill) : null
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
      models: body.models ? JSON.stringify(body.models) : null,
      skill: body.skill ? JSON.stringify(body.skill) : null,
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

  // WoT data for current user
  const wotData = user.nostrPubkey ? await getWotData(db, user.nostrPubkey) : { trusted_by: 0, trusted_by_your_follows: 0 }
  const reviewData = user.nostrPubkey ? await getReviewData(db, user.nostrPubkey) : { avg_rating: 0, review_count: 0 }

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
      reputation: buildReputationData(s, wotData, reviewData),
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

// POST /api/dvm/trust — 声明信任某个 DVM Provider
api.post('/dvm/trust', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const body = await c.req.json<{ target_pubkey?: string; target_npub?: string; target_username?: string }>()

  // Resolve target to hex pubkey
  let targetPubkey: string | null = null
  if (body.target_pubkey) {
    targetPubkey = body.target_pubkey
  } else if (body.target_npub) {
    targetPubkey = npubToPubkey(body.target_npub)
  } else if (body.target_username) {
    const target = await db.select({ nostrPubkey: users.nostrPubkey }).from(users)
      .where(eq(users.username, body.target_username)).limit(1)
    if (target.length > 0 && target[0].nostrPubkey) targetPubkey = target[0].nostrPubkey
  }

  if (!targetPubkey) return c.json({ error: 'Could not resolve target pubkey' }, 400)
  if (targetPubkey === user.nostrPubkey) return c.json({ error: 'Cannot trust yourself' }, 400)

  // Check for existing trust
  const existing = await db.select({ id: dvmTrust.id }).from(dvmTrust)
    .where(and(eq(dvmTrust.userId, user.id), eq(dvmTrust.targetPubkey, targetPubkey)))
    .limit(1)
  if (existing.length > 0) return c.json({ error: 'Already trusted' }, 409)

  const trustId = generateId()
  let nostrEventId: string | null = null

  // Build Kind 30382 event and send to relay
  if (user.nostrPrivEncrypted && user.nostrPrivIv && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    try {
      const event = await buildDvmTrustEvent({
        privEncrypted: user.nostrPrivEncrypted,
        iv: user.nostrPrivIv,
        masterKey: c.env.NOSTR_MASTER_KEY,
        targetPubkey,
      })
      nostrEventId = event.id
      c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
    } catch (e) {
      console.error('[API] Failed to build trust event:', e)
    }
  }

  await db.insert(dvmTrust).values({
    id: trustId,
    userId: user.id,
    targetPubkey,
    nostrEventId,
    createdAt: new Date(),
  })

  return c.json({ ok: true, trust_id: trustId })
})

// DELETE /api/dvm/trust/:pubkey — 撤销信任
api.delete('/dvm/trust/:pubkey', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const targetPubkey = c.req.param('pubkey')

  const existing = await db.select({ id: dvmTrust.id, nostrEventId: dvmTrust.nostrEventId }).from(dvmTrust)
    .where(and(eq(dvmTrust.userId, user.id), eq(dvmTrust.targetPubkey, targetPubkey)))
    .limit(1)

  if (existing.length === 0) return c.json({ error: 'Trust not found' }, 404)

  await db.delete(dvmTrust).where(eq(dvmTrust.id, existing[0].id))

  // Send Kind 5 deletion event if we have the original event ID
  if (existing[0].nostrEventId && user.nostrPrivEncrypted && user.nostrPrivIv && c.env.NOSTR_MASTER_KEY && c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil((async () => {
      try {
        const event = await buildSignedEvent({
          privEncrypted: user.nostrPrivEncrypted!,
          iv: user.nostrPrivIv!,
          masterKey: c.env.NOSTR_MASTER_KEY!,
          kind: 5,
          content: '',
          tags: [['e', existing[0].nostrEventId!]],
        })
        await c.env.NOSTR_QUEUE!.send({ events: [event] })
      } catch (e) {
        console.error('[API] Failed to send trust deletion event:', e)
      }
    })())
  }

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
  let customerJobId: string | null = null
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
      customerJobId = customerJob[0].id
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
      content: `✅ Completed a ${kindLabel} job${customerJobId ? `\n\n${c.env.APP_URL || new URL(c.req.url).origin}/jobs/${customerJobId}` : ''} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    const eventsToSend: NostrEvent[] = [resultEvent, noteEvent]

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
          reputation: buildReputationData(updatedSvc[0],
            user.nostrPubkey
              ? await getWotData(db, user.nostrPubkey)
              : { trusted_by: 0, trusted_by_your_follows: 0 },
            user.nostrPubkey
              ? await getReviewData(db, user.nostrPubkey)
              : { avg_rating: 0, review_count: 0 }),
        })
        eventsToSend.push(...handlerEvts)
      }
    }

    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: eventsToSend }))
  }

  return c.json({ ok: true, event_id: resultEvent.id }, 201)
})


// POST /api/dvm/jobs/:id/complete — Customer confirms result, pay provider via NWC or CLINK
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

  // Payment via NWC or CLINK (if amount > 0)
  let paymentResult: { preimage?: string; paid_sats?: number; fee_sats?: number; method?: string } = {}

  if (totalPaymentSats > 0) {
    const hasNwc = user.nwcEnabled && user.nwcEncrypted && user.nwcIv && c.env.NOSTR_MASTER_KEY
    const hasClink = user.clinkNdebitEnabled && user.clinkNdebitEncrypted && user.clinkNdebitIv && c.env.NOSTR_MASTER_KEY

    if (!hasNwc && !hasClink) {
      return c.json({ error: 'No payment method configured. Connect a wallet via PUT /api/me (nwc_connection_string or clink_ndebit).' }, 400)
    }

    // Resolve provider Lightning Address
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

    // --- Path 1: NWC (preferred) ---
    if (hasNwc) {
      if (!job[0].bolt11 && !providerLightningAddress) {
        return c.json({ error: 'Cannot pay: provider has no Lightning invoice or Lightning Address' }, 400)
      }

      const nwcUri = await decryptNwcUri(user.nwcEncrypted!, user.nwcIv!, c.env.NOSTR_MASTER_KEY!)
      const nwcParsed = parseNwcUri(nwcUri)

      // Pay platform fee
      if (feeSats > 0) {
        try {
          await resolveAndPayLightningAddress(nwcParsed, platformAddress, feeSats)
          console.log(`[DVM] Platform fee (NWC): ${feeSats} sats → ${platformAddress}`)
        } catch (e) {
          return c.json({ error: 'Platform fee payment failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 502)
        }
      }

      // Pay provider
      if (job[0].bolt11) {
        try {
          const result = await nwcPayInvoice(nwcParsed, job[0].bolt11)
          paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats, method: 'nwc' }
        } catch (e) {
          return c.json({ error: 'NWC payment failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 502)
        }
      } else {
        try {
          const result = await resolveAndPayLightningAddress(nwcParsed, providerLightningAddress!, providerSats)
          paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats, method: 'nwc' }
        } catch (e) {
          return c.json({ error: 'NWC payment to Lightning Address failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 502)
        }
      }

    // --- Path 2: CLINK ndebit (fallback) ---
    } else {
      if (!providerLightningAddress) {
        return c.json({ error: 'Cannot pay via CLINK: provider has no Lightning Address' }, 400)
      }

      const ndebit = await decryptNdebit(user.clinkNdebitEncrypted!, user.clinkNdebitIv!, c.env.NOSTR_MASTER_KEY!)

      // Pay platform fee
      if (feeSats > 0) {
        try {
          const feeResult = await debitForPayment({ ndebit, lightningAddress: platformAddress, amountSats: feeSats, masterKey: c.env.NOSTR_MASTER_KEY! })
          if (!feeResult.ok) throw new Error(feeResult.error || 'Debit rejected')
          console.log(`[DVM] Platform fee (CLINK): ${feeSats} sats → ${platformAddress}`)
        } catch (e) {
          return c.json({ error: 'Platform fee payment failed (CLINK)', detail: e instanceof Error ? e.message : 'Unknown error' }, 502)
        }
      }

      // Pay provider
      try {
        const result = await debitForPayment({ ndebit, lightningAddress: providerLightningAddress, amountSats: providerSats, masterKey: c.env.NOSTR_MASTER_KEY! })
        if (!result.ok) throw new Error(result.error || 'Debit rejected')
        paymentResult = { preimage: result.preimage, paid_sats: totalPaymentSats, fee_sats: feeSats, method: 'clink' }
      } catch (e) {
        return c.json({ error: 'CLINK debit payment failed', detail: e instanceof Error ? e.message : 'Unknown error' }, 502)
      }
    }
  }

  // Mark customer job as completed with payment info
  await db.update(dvmJobs)
    .set({
      status: 'completed',
      paidMsats: paymentResult.paid_sats ? paymentResult.paid_sats * 1000 : null,
      paymentMethod: paymentResult.method || null,
      updatedAt: new Date(),
    })
    .where(eq(dvmJobs.id, jobId))

  // Update provider's totalEarnedMsats
  if (paymentResult.paid_sats && job[0].requestEventId) {
    const providerJob = await db.select({ userId: dvmJobs.userId }).from(dvmJobs)
      .where(and(
        eq(dvmJobs.requestEventId, job[0].requestEventId),
        eq(dvmJobs.role, 'provider'),
      ))
      .limit(1)
    if (providerJob.length > 0) {
      const providerSvc = await db.select({ id: dvmServices.id, totalEarnedMsats: dvmServices.totalEarnedMsats })
        .from(dvmServices).where(eq(dvmServices.userId, providerJob[0].userId)).limit(1)
      if (providerSvc.length > 0) {
        await db.update(dvmServices).set({
          totalEarnedMsats: (providerSvc[0].totalEarnedMsats || 0) + providerSats * 1000,
          updatedAt: new Date(),
        }).where(eq(dvmServices.id, providerSvc[0].id))
      }
    }
  }

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
      content: `🤝 Job done: ${kindLabel}${paidStr}\n\n${c.env.APP_URL || new URL(c.req.url).origin}/jobs/${jobId} #dvm #2020117`,
      tags: [['t', 'dvm'], ['t', '2020117']],
    })
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [noteEvent] }))
  }

  // Check if this job is part of a workflow — auto-advance
  try {
    await advanceWorkflow(db, c.env, jobId)
  } catch (e) {
    console.error(`[Workflow] Failed to advance after complete ${jobId}:`, e)
  }

  return c.json({
    ok: true,
    ...(paymentResult.paid_sats ? { paid_sats: paymentResult.paid_sats, provider_sats: providerSats, fee_sats: paymentResult.fee_sats, payment_method: paymentResult.method } : {}),
  })
})


// ─── Phase 1: Kind 30333 — Agent Heartbeat ───

// POST /api/heartbeat — 发送心跳
api.post('/heartbeat', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !user.nostrPubkey || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    capacity?: number
    p2p_stats?: { sessions?: number; earned_sats?: number; active?: boolean }
  }

  // Auto-read kinds/pricing from dvmServices
  const svc = await db.select({ kinds: dvmServices.kinds, pricingMin: dvmServices.pricingMin, pricingMax: dvmServices.pricingMax, models: dvmServices.models })
    .from(dvmServices)
    .where(and(eq(dvmServices.userId, user.id), eq(dvmServices.active, 1)))
    .limit(1)

  let kinds: number[] = []
  let pricing: Record<string, number> = {}
  let models: string[] = []
  if (svc.length > 0) {
    kinds = JSON.parse(svc[0].kinds)
    if (svc[0].pricingMin) {
      for (const k of kinds) pricing[String(k)] = Math.floor(svc[0].pricingMin / 1000)
    }
    if (svc[0].models) models = JSON.parse(svc[0].models)
  }

  const event = await buildHeartbeatEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    pubkey: user.nostrPubkey,
    capacity: body.capacity,
    kinds,
    pricing,
    models,
  })

  // Upsert heartbeat locally
  const now = new Date()
  const existing = await db.select({ id: agentHeartbeats.id }).from(agentHeartbeats)
    .where(eq(agentHeartbeats.userId, user.id)).limit(1)

  const p2pStatsJson = body.p2p_stats ? JSON.stringify(body.p2p_stats) : null

  if (existing.length > 0) {
    await db.update(agentHeartbeats).set({
      status: 'online',
      capacity: body.capacity || 0,
      kinds: kinds.length > 0 ? JSON.stringify(kinds) : null,
      pricing: Object.keys(pricing).length > 0 ? JSON.stringify(pricing) : null,
      p2pStats: p2pStatsJson,
      nostrEventId: event.id,
      lastSeenAt: Math.floor(Date.now() / 1000),
      updatedAt: now,
    }).where(eq(agentHeartbeats.id, existing[0].id))
  } else {
    await db.insert(agentHeartbeats).values({
      id: generateId(),
      userId: user.id,
      status: 'online',
      capacity: body.capacity || 0,
      kinds: kinds.length > 0 ? JSON.stringify(kinds) : null,
      pricing: Object.keys(pricing).length > 0 ? JSON.stringify(pricing) : null,
      p2pStats: p2pStatsJson,
      nostrEventId: event.id,
      lastSeenAt: Math.floor(Date.now() / 1000),
      createdAt: now,
      updatedAt: now,
    })
  }

  // Publish to relay
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
  }

  return c.json({ ok: true, event_id: event.id })
})

// POST /api/dvm/session-report — P2P session 结算上报（Provider 调用）
api.post('/dvm/session-report', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const body = await c.req.json<{ kind: number; duration_s: number; total_sats: number }>()

  if (!body.kind || body.duration_s == null || body.total_sats == null) {
    return c.json({ error: 'kind, duration_s, and total_sats required' }, 400)
  }

  const now = new Date()
  const jobId = generateId()

  await db.insert(dvmJobs).values({
    id: jobId,
    userId: user.id,
    role: 'provider',
    kind: body.kind,
    status: 'completed',
    input: null,
    result: null,
    paidMsats: body.total_sats * 1000,
    paymentMethod: 'p2p',
    params: JSON.stringify({ channel: 'p2p', duration_s: body.duration_s }),
    providerPubkey: user.nostrPubkey,
    createdAt: now,
    updatedAt: now,
  })

  // Update provider total earned
  const svc = await db.select({ id: dvmServices.id, totalEarnedMsats: dvmServices.totalEarnedMsats })
    .from(dvmServices).where(eq(dvmServices.userId, user.id)).limit(1)
  if (svc.length > 0) {
    await db.update(dvmServices)
      .set({ totalEarnedMsats: (svc[0].totalEarnedMsats || 0) + body.total_sats * 1000 })
      .where(eq(dvmServices.id, svc[0].id))
  }

  return c.json({ ok: true, job_id: jobId })
})

// GET /api/agents/online — 在线 Agent 列表
api.get('/agents/online', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind')

  const featureFilter = c.req.query('feature')

  let query = db.select({
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    nostrPubkey: users.nostrPubkey,
    status: agentHeartbeats.status,
    capacity: agentHeartbeats.capacity,
    kinds: agentHeartbeats.kinds,
    pricing: agentHeartbeats.pricing,
    p2pStats: agentHeartbeats.p2pStats,
    lastSeenAt: agentHeartbeats.lastSeenAt,
    models: dvmServices.models,
    skill: dvmServices.skill,
  })
    .from(agentHeartbeats)
    .innerJoin(users, eq(agentHeartbeats.userId, users.id))
    .leftJoin(dvmServices, and(eq(dvmServices.userId, agentHeartbeats.userId), eq(dvmServices.active, 1)))
    .where(eq(agentHeartbeats.status, 'online'))

  const rows = await query

  let agents = rows.map(r => ({
    username: r.username,
    display_name: r.displayName,
    avatar_url: r.avatarUrl,
    nostr_pubkey: r.nostrPubkey,
    npub: r.nostrPubkey ? pubkeyToNpub(r.nostrPubkey) : null,
    status: r.status,
    capacity: r.capacity || 0,
    kinds: r.kinds ? JSON.parse(r.kinds) : [],
    pricing: r.pricing ? JSON.parse(r.pricing) : null,
    p2p_stats: r.p2pStats ? JSON.parse(r.p2pStats) : null,
    models: r.models ? JSON.parse(r.models) : [],
    last_seen_at: r.lastSeenAt,
    _skill: r.skill,
  }))

  // Filter by kind if specified
  if (kindFilter) {
    const kind = parseInt(kindFilter)
    agents = agents.filter(a => a.kinds.includes(kind))
  }

  // Filter by feature if specified
  if (featureFilter) {
    agents = agents.filter(a => {
      if (!a._skill) return false
      try {
        const skill = JSON.parse(a._skill)
        return Array.isArray(skill.features) && skill.features.includes(featureFilter)
      } catch { return false }
    })
  }

  // Strip internal _skill field from response
  const result = agents.map(({ _skill, ...rest }) => rest)

  return c.json({ agents: result, total: result.length })
})

// ─── Phase 2: Kind 31117 — Job Review ───

// POST /api/dvm/jobs/:id/review — 提交评价
api.post('/dvm/jobs/:id/review', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !user.nostrPubkey || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    rating?: number
    content?: string
  }

  if (!body.rating || body.rating < 1 || body.rating > 5) {
    return c.json({ error: 'rating must be 1-5' }, 400)
  }

  // Find the job
  const job = await db.select().from(dvmJobs)
    .where(eq(dvmJobs.id, jobId))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'completed') return c.json({ error: 'Can only review completed jobs' }, 400)

  // Determine role and target
  let role: string
  let targetPubkey: string
  if (job[0].userId === user.id && job[0].role === 'customer') {
    role = 'customer'
    targetPubkey = job[0].providerPubkey || ''
  } else if (job[0].userId === user.id && job[0].role === 'provider') {
    role = 'provider'
    targetPubkey = job[0].customerPubkey || ''
  } else {
    return c.json({ error: 'Only job participants can review' }, 403)
  }

  if (!targetPubkey) return c.json({ error: 'Target pubkey not found' }, 400)

  // Dedup check
  const existing = await db.select({ id: dvmReviews.id }).from(dvmReviews)
    .where(and(eq(dvmReviews.jobId, jobId), eq(dvmReviews.reviewerUserId, user.id)))
    .limit(1)

  if (existing.length > 0) return c.json({ error: 'Already reviewed this job' }, 409)

  const jobEventId = job[0].requestEventId || job[0].eventId || ''

  const event = await buildJobReviewEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    jobEventId,
    targetPubkey,
    rating: body.rating,
    role,
    jobKind: job[0].kind,
    content: body.content,
  })

  await db.insert(dvmReviews).values({
    id: generateId(),
    jobId,
    reviewerUserId: user.id,
    targetPubkey,
    rating: body.rating,
    content: body.content || null,
    role,
    jobKind: job[0].kind,
    nostrEventId: event.id,
    createdAt: new Date(),
  })

  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
  }

  return c.json({ ok: true, event_id: event.id }, 201)
})

// ─── Phase 3: Kind 21117 — Data Escrow ───

// POST /api/dvm/jobs/:id/escrow — Provider: 提交加密结果
api.post('/dvm/jobs/:id/escrow', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !user.nostrPubkey || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'provider')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (!job[0].customerPubkey || !job[0].requestEventId) {
    return c.json({ error: 'Job missing request data' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    content?: string
    preview?: string
  }

  if (!body.content) return c.json({ error: 'content is required' }, 400)

  // Compute SHA-256 hash of plaintext
  const { decryptNostrPrivkey } = await import('../services/nostr')
  const { nip04Encrypt } = await import('../services/nwc')

  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(body.content))
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

  // NIP-04 encrypt content
  const privkeyHex = await decryptNostrPrivkey(user.nostrPrivEncrypted!, user.nostrPrivIv!, c.env.NOSTR_MASTER_KEY)
  const encrypted = await nip04Encrypt(privkeyHex, job[0].customerPubkey, body.content)

  const event = await buildEscrowResultEvent({
    privEncrypted: user.nostrPrivEncrypted!,
    iv: user.nostrPrivIv!,
    masterKey: c.env.NOSTR_MASTER_KEY,
    customerPubkey: job[0].customerPubkey,
    jobEventId: job[0].requestEventId,
    encryptedPayload: encrypted,
    hash: hashHex,
    preview: body.preview,
  })

  const now = new Date()

  // Update provider job
  await db.update(dvmJobs).set({
    status: 'completed',
    result: body.content,
    resultEventId: event.id,
    updatedAt: now,
  }).where(eq(dvmJobs.id, jobId))

  // Update customer job if same-site
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
      await db.update(dvmJobs).set({
        status: 'result_available',
        encryptedResult: encrypted,
        resultHash: hashHex,
        resultPreview: body.preview || null,
        providerPubkey: user.nostrPubkey,
        resultEventId: event.id,
        updatedAt: now,
      }).where(eq(dvmJobs.id, customerJob[0].id))
    }
  }

  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event] }))
  }

  return c.json({ ok: true, event_id: event.id, hash: hashHex }, 201)
})

// POST /api/dvm/jobs/:id/decrypt — Customer: 付款后解密
api.post('/dvm/jobs/:id/decrypt', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const jobId = c.req.param('id')

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const job = await db.select().from(dvmJobs)
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.userId, user.id), eq(dvmJobs.role, 'customer')))
    .limit(1)

  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)
  if (job[0].status !== 'completed') return c.json({ error: 'Job must be completed (paid) before decryption' }, 400)
  if (!job[0].encryptedResult || !job[0].providerPubkey) {
    return c.json({ error: 'No encrypted result available' }, 400)
  }

  const { decryptNostrPrivkey } = await import('../services/nostr')
  const { nip04Decrypt } = await import('../services/nwc')

  const privkeyHex = await decryptNostrPrivkey(user.nostrPrivEncrypted!, user.nostrPrivIv!, c.env.NOSTR_MASTER_KEY)
  const plaintext = await nip04Decrypt(privkeyHex, job[0].providerPubkey, job[0].encryptedResult)

  // Verify hash
  const encoder = new TextEncoder()
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(plaintext))
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')

  if (job[0].resultHash && hashHex !== job[0].resultHash) {
    return c.json({ error: 'Hash mismatch — data integrity check failed', expected: job[0].resultHash, got: hashHex }, 422)
  }

  // Store decrypted result
  await db.update(dvmJobs).set({
    result: plaintext,
    updatedAt: new Date(),
  }).where(eq(dvmJobs.id, jobId))

  return c.json({ ok: true, result: plaintext, hash_verified: true })
})

// ─── Phase 4: Kind 5117 — Workflow Chain ───

// POST /api/dvm/workflow — 创建工作流
api.post('/dvm/workflow', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !user.nostrPubkey || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    description?: string
    input?: string
    input_type?: string
    steps?: { kind: number; provider?: string; description?: string }[]
    bid_sats?: number
  }

  if (!body.input) return c.json({ error: 'input is required' }, 400)
  if (!body.steps || body.steps.length < 2) return c.json({ error: 'At least 2 steps required' }, 400)
  if (body.steps.length > 10) return c.json({ error: 'Maximum 10 steps' }, 400)

  const bidSats = body.bid_sats || 0
  const inputType = body.input_type || 'text'

  // Build workflow event
  const event = await buildWorkflowEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    description: body.description || '',
    input: body.input,
    inputType,
    steps: body.steps,
    bidMsats: bidSats ? bidSats * 1000 : undefined,
  })

  const now = new Date()
  const workflowId = generateId()

  // Create workflow
  await db.insert(dvmWorkflows).values({
    id: workflowId,
    userId: user.id,
    status: 'running',
    description: body.description || null,
    totalBidSats: bidSats,
    nostrEventId: event.id,
    currentStep: 0,
    totalSteps: body.steps.length,
    createdAt: now,
    updatedAt: now,
  })

  // Create steps
  for (let i = 0; i < body.steps.length; i++) {
    await db.insert(dvmWorkflowSteps).values({
      id: generateId(),
      workflowId,
      stepIndex: i,
      kind: body.steps[i].kind,
      description: body.steps[i].description || null,
      input: i === 0 ? body.input : null,
      provider: body.steps[i].provider || null,
      status: i === 0 ? 'running' : 'pending',
      createdAt: now,
      updatedAt: now,
    })
  }

  // Create first DVM job (step 0)
  const stepBidMsats = bidSats ? Math.floor((bidSats * 1000) / body.steps.length) : undefined
  const firstJobEvent = await buildJobRequestEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    kind: body.steps[0].kind,
    input: body.input,
    inputType,
    bidMsats: stepBidMsats,
  })

  const firstJobId = generateId()
  await db.insert(dvmJobs).values({
    id: firstJobId,
    userId: user.id,
    role: 'customer',
    kind: body.steps[0].kind,
    status: 'open',
    input: body.input,
    inputType,
    bidMsats: stepBidMsats || null,
    customerPubkey: user.nostrPubkey,
    requestEventId: firstJobEvent.id,
    eventId: firstJobEvent.id,
    createdAt: now,
    updatedAt: now,
  })

  // Link first step to job
  await db.update(dvmWorkflowSteps).set({ jobId: firstJobId, updatedAt: now })
    .where(and(eq(dvmWorkflowSteps.workflowId, workflowId), eq(dvmWorkflowSteps.stepIndex, 0)))

  // Publish events
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [event, firstJobEvent] }))
  }

  return c.json({ ok: true, workflow_id: workflowId, first_job_id: firstJobId, event_id: event.id }, 201)
})

// GET /api/dvm/workflows — 我的工作流列表
api.get('/dvm/workflows', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)

  const [countResult, workflows] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmWorkflows).where(eq(dvmWorkflows.userId, user.id)),
    db.select().from(dvmWorkflows)
      .where(eq(dvmWorkflows.userId, user.id))
      .orderBy(desc(dvmWorkflows.createdAt))
      .limit(limit)
      .offset((page - 1) * limit),
  ])

  return c.json({
    workflows: workflows.map(w => ({
      id: w.id,
      status: w.status,
      description: w.description,
      total_bid_sats: w.totalBidSats,
      current_step: w.currentStep,
      total_steps: w.totalSteps,
      created_at: w.createdAt,
      updated_at: w.updatedAt,
    })),
    meta: paginationMeta(countResult[0]?.count || 0, page, limit),
  })
})

// GET /api/dvm/workflows/:id — 工作流详情
api.get('/dvm/workflows/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const workflowId = c.req.param('id')

  const workflow = await db.select().from(dvmWorkflows)
    .where(and(eq(dvmWorkflows.id, workflowId), eq(dvmWorkflows.userId, user.id)))
    .limit(1)

  if (workflow.length === 0) return c.json({ error: 'Workflow not found' }, 404)

  const steps = await db.select().from(dvmWorkflowSteps)
    .where(eq(dvmWorkflowSteps.workflowId, workflowId))
    .orderBy(asc(dvmWorkflowSteps.stepIndex))

  return c.json({
    id: workflow[0].id,
    status: workflow[0].status,
    description: workflow[0].description,
    total_bid_sats: workflow[0].totalBidSats,
    current_step: workflow[0].currentStep,
    total_steps: workflow[0].totalSteps,
    created_at: workflow[0].createdAt,
    updated_at: workflow[0].updatedAt,
    steps: steps.map(s => ({
      step_index: s.stepIndex,
      kind: s.kind,
      description: s.description,
      input: s.input,
      output: s.output,
      job_id: s.jobId,
      provider: s.provider,
      status: s.status,
    })),
  })
})

// ─── Phase 5: Kind 5118 — Agent Swarm ───

// POST /api/dvm/swarm — 创建 swarm 任务
api.post('/dvm/swarm', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!

  if (!user.nostrPrivEncrypted || !user.nostrPrivIv || !user.nostrPubkey || !c.env.NOSTR_MASTER_KEY) {
    return c.json({ error: 'Nostr keys not configured' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    kind?: number
    input?: string
    input_type?: string
    content?: string
    max_providers?: number
    judge?: string
    bid_sats?: number
  }

  if (!body.kind) return c.json({ error: 'kind is required' }, 400)
  if (!body.input) return c.json({ error: 'input is required' }, 400)
  if (!body.max_providers || body.max_providers < 2) return c.json({ error: 'max_providers must be >= 2' }, 400)
  if (body.max_providers > 20) return c.json({ error: 'max_providers must be <= 20' }, 400)

  const inputType = body.input_type || 'text'
  const bidSats = body.bid_sats || 0

  // Build swarm event (Kind 5118)
  const swarmEvent = await buildSwarmEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    content: body.content || body.input,
    input: body.input,
    inputType,
    maxProviders: body.max_providers,
    judge: body.judge,
    bidMsats: bidSats ? bidSats * 1000 : undefined,
    kind: 5118,
  })

  // Also build standard Kind 5xxx job request
  const jobEvent = await buildJobRequestEvent({
    privEncrypted: user.nostrPrivEncrypted,
    iv: user.nostrPrivIv,
    masterKey: c.env.NOSTR_MASTER_KEY,
    kind: body.kind,
    input: body.input,
    inputType,
    bidMsats: bidSats ? bidSats * 1000 : undefined,
  })

  const now = new Date()
  const jobId = generateId()
  const swarmId = generateId()

  // Create customer job
  await db.insert(dvmJobs).values({
    id: jobId,
    userId: user.id,
    role: 'customer',
    kind: body.kind,
    status: 'open',
    input: body.input,
    inputType,
    bidMsats: bidSats ? bidSats * 1000 : null,
    customerPubkey: user.nostrPubkey,
    requestEventId: jobEvent.id,
    eventId: jobEvent.id,
    createdAt: now,
    updatedAt: now,
  })

  // Create swarm
  await db.insert(dvmSwarms).values({
    id: swarmId,
    userId: user.id,
    jobId,
    maxProviders: body.max_providers,
    judge: body.judge || 'customer',
    status: 'collecting',
    nostrEventId: swarmEvent.id,
    createdAt: now,
    updatedAt: now,
  })

  // Publish both events
  if (c.env.NOSTR_QUEUE) {
    c.executionCtx.waitUntil(c.env.NOSTR_QUEUE.send({ events: [swarmEvent, jobEvent] }))
  }

  return c.json({ ok: true, swarm_id: swarmId, job_id: jobId, event_id: swarmEvent.id }, 201)
})

// GET /api/dvm/swarm/:id — swarm 详情
api.get('/dvm/swarm/:id', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const swarmId = c.req.param('id')

  const swarm = await db.select().from(dvmSwarms)
    .where(eq(dvmSwarms.id, swarmId))
    .limit(1)

  if (swarm.length === 0) return c.json({ error: 'Swarm not found' }, 404)

  const submissions = await db.select({
    id: dvmSwarmSubmissions.id,
    providerPubkey: dvmSwarmSubmissions.providerPubkey,
    providerUserId: dvmSwarmSubmissions.providerUserId,
    result: dvmSwarmSubmissions.result,
    status: dvmSwarmSubmissions.status,
    createdAt: dvmSwarmSubmissions.createdAt,
    username: users.username,
    displayName: users.displayName,
  })
    .from(dvmSwarmSubmissions)
    .leftJoin(users, eq(dvmSwarmSubmissions.providerUserId, users.id))
    .where(eq(dvmSwarmSubmissions.swarmId, swarmId))
    .orderBy(asc(dvmSwarmSubmissions.createdAt))

  return c.json({
    id: swarm[0].id,
    job_id: swarm[0].jobId,
    max_providers: swarm[0].maxProviders,
    judge: swarm[0].judge,
    status: swarm[0].status,
    winner_id: swarm[0].winnerId,
    created_at: swarm[0].createdAt,
    submissions: submissions.map(s => ({
      id: s.id,
      provider_pubkey: s.providerPubkey,
      provider_username: s.username,
      provider_display_name: s.displayName,
      result: s.result,
      status: s.status,
      created_at: s.createdAt,
    })),
  })
})

// POST /api/dvm/swarm/:id/submit — Provider: 提交结果
api.post('/dvm/swarm/:id/submit', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const swarmId = c.req.param('id')

  if (!user.nostrPubkey) return c.json({ error: 'Nostr key not configured' }, 400)

  const swarm = await db.select().from(dvmSwarms)
    .where(eq(dvmSwarms.id, swarmId))
    .limit(1)

  if (swarm.length === 0) return c.json({ error: 'Swarm not found' }, 404)
  if (swarm[0].status !== 'collecting') return c.json({ error: 'Swarm is not accepting submissions' }, 400)
  if (swarm[0].userId === user.id) return c.json({ error: 'Cannot submit to your own swarm' }, 400)

  const body = await c.req.json().catch(() => ({})) as {
    result?: string
  }

  if (!body.result) return c.json({ error: 'result is required' }, 400)

  // Dedup check
  const existing = await db.select({ id: dvmSwarmSubmissions.id }).from(dvmSwarmSubmissions)
    .where(and(eq(dvmSwarmSubmissions.swarmId, swarmId), eq(dvmSwarmSubmissions.providerPubkey, user.nostrPubkey)))
    .limit(1)

  if (existing.length > 0) return c.json({ error: 'Already submitted to this swarm' }, 409)

  const submissionId = generateId()
  await db.insert(dvmSwarmSubmissions).values({
    id: submissionId,
    swarmId,
    providerUserId: user.id,
    providerPubkey: user.nostrPubkey,
    result: body.result,
    status: 'submitted',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  // Check if we've reached max_providers → move to judging
  const subCount = await db.select({ count: sql<number>`COUNT(*)` })
    .from(dvmSwarmSubmissions)
    .where(eq(dvmSwarmSubmissions.swarmId, swarmId))

  if ((subCount[0]?.count || 0) >= swarm[0].maxProviders) {
    await db.update(dvmSwarms).set({ status: 'judging', updatedAt: new Date() })
      .where(eq(dvmSwarms.id, swarmId))
  }

  return c.json({ ok: true, submission_id: submissionId })
})

// POST /api/dvm/swarm/:id/select — Customer: 选最佳
api.post('/dvm/swarm/:id/select', requireApiAuth, async (c) => {
  const db = c.get('db')
  const user = c.get('user')!
  const swarmId = c.req.param('id')

  const swarm = await db.select().from(dvmSwarms)
    .where(and(eq(dvmSwarms.id, swarmId), eq(dvmSwarms.userId, user.id)))
    .limit(1)

  if (swarm.length === 0) return c.json({ error: 'Swarm not found' }, 404)
  if (swarm[0].status !== 'collecting' && swarm[0].status !== 'judging') {
    return c.json({ error: 'Swarm is not in selection phase' }, 400)
  }

  const body = await c.req.json().catch(() => ({})) as {
    submission_id?: string
  }

  if (!body.submission_id) return c.json({ error: 'submission_id is required' }, 400)

  // Verify submission exists and belongs to this swarm
  const submission = await db.select().from(dvmSwarmSubmissions)
    .where(and(eq(dvmSwarmSubmissions.id, body.submission_id), eq(dvmSwarmSubmissions.swarmId, swarmId)))
    .limit(1)

  if (submission.length === 0) return c.json({ error: 'Submission not found' }, 404)

  const now = new Date()

  // Mark winner
  await db.update(dvmSwarmSubmissions).set({ status: 'winner', updatedAt: now })
    .where(eq(dvmSwarmSubmissions.id, body.submission_id))

  // Mark others as rejected
  await db.update(dvmSwarmSubmissions).set({ status: 'rejected', updatedAt: now })
    .where(and(
      eq(dvmSwarmSubmissions.swarmId, swarmId),
      sql`${dvmSwarmSubmissions.id} != ${body.submission_id}`,
    ))

  // Update swarm status
  await db.update(dvmSwarms).set({
    status: 'completed',
    winnerId: body.submission_id,
    updatedAt: now,
  }).where(eq(dvmSwarms.id, swarmId))

  // Update the customer job with the winning result
  await db.update(dvmJobs).set({
    status: 'result_available',
    result: submission[0].result,
    providerPubkey: submission[0].providerPubkey,
    updatedAt: now,
  }).where(eq(dvmJobs.id, swarm[0].jobId))

  return c.json({ ok: true, winner: body.submission_id })
})

// POST /api/dvm/proxy-debit — Provider requests platform to debit customer's wallet
export default api
