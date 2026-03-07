import { Hono } from 'hono'
import { eq, and, desc, sql } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, topics, comments, userFollows, dvmJobs, dvmServices, nostrReports } from '../db/schema'
import { stripHtml } from '../lib/utils'
import { pubkeyToNpub, npubToPubkey } from '../services/nostr'
import { paginationMeta, getWotData, getReviewData, buildReputationData, DVM_KIND_LABELS, REPORT_FLAG_THRESHOLD } from './helpers'

const usersRouter = new Hono<AppContext>()

// GET /api/users/:identifier — 公开用户档案
usersRouter.get('/:identifier', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier').trim()

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

  const [followersCount, followingCount, topicsCount, customerJobsCount, providerJobsCount] = await Promise.all([
    db.select({ count: sql<number>`COUNT(*)` }).from(userFollows).where(eq(userFollows.followeeId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(userFollows).where(eq(userFollows.followerId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(eq(topics.userId, u.id)),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(and(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'customer'))),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(and(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'provider'))),
  ])

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

  let reportCount = 0
  if (agentSvc.length > 0 && u.nostrPubkey) {
    const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
      .from(nostrReports).where(eq(nostrReports.targetPubkey, u.nostrPubkey))
    reportCount = rc[0]?.count || 0
  }

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
usersRouter.get('/:identifier/activity', async (c) => {
  const db = c.get('db')
  const identifier = c.req.param('identifier').trim()
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

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

  const [userTopics, userComments, userJobs] = await Promise.all([
    db.select({ id: topics.id, title: topics.title, content: topics.content, createdAt: topics.createdAt })
      .from(topics).where(eq(topics.userId, u.id)).orderBy(desc(topics.createdAt)).limit(limit),
    db.select({ id: comments.id, content: comments.content, topicId: comments.topicId, createdAt: comments.createdAt })
      .from(comments).where(eq(comments.userId, u.id)).orderBy(desc(comments.createdAt)).limit(limit),
    db.select({ id: dvmJobs.id, kind: dvmJobs.kind, role: dvmJobs.role, status: dvmJobs.status, input: dvmJobs.input, result: dvmJobs.result, createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt })
      .from(dvmJobs).where(eq(dvmJobs.userId, u.id)).orderBy(desc(dvmJobs.updatedAt)).limit(limit),
  ])

  const activities: { type: string; id: string; time: Date; data: Record<string, unknown> }[] = []

  for (const t of userTopics) {
    activities.push({ type: 'topic', id: t.id, time: t.createdAt, data: { title: t.title, content: t.content ? stripHtml(t.content).slice(0, 300) : null } })
  }
  for (const cm of userComments) {
    activities.push({ type: 'comment', id: cm.id, time: cm.createdAt, data: { topic_id: cm.topicId, content: cm.content ? stripHtml(cm.content).slice(0, 300) : null } })
  }
  for (const j of userJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    activities.push({ type: 'dvm_job', id: j.id, time: j.updatedAt, data: { kind: j.kind, kind_label: kindLabel, role: j.role, status: j.status, input: j.input, result: j.status === 'completed' || j.status === 'result_available' ? j.result : null } })
  }

  activities.sort((a, b) => b.time.getTime() - a.time.getTime())
  const total = activities.length
  const paged = activities.slice(offset, offset + limit)

  return c.json({
    user: { id: u.id, username: u.username, display_name: u.displayName },
    activities: paged.map(a => ({ type: a.type, id: a.id, created_at: a.time, ...a.data })),
    meta: paginationMeta(total, page, limit),
  })
})

export default usersRouter
