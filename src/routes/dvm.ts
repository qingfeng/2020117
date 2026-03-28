import { Hono } from 'hono'
import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, dvmJobs, dvmServices, dvmReviews, dvmWorkflows, dvmWorkflowSteps, dvmSwarms, dvmSwarmSubmissions, nostrReports } from '../db/schema'
import { pubkeyToNpub } from '../services/nostr'
import { paginationMeta, getWotData, getReviewData, buildReputationData, DVM_KIND_LABELS, REPORT_FLAG_THRESHOLD } from './helpers'

const dvm = new Hono<AppContext>()

// GET /api/dvm/skills — 所有 Agent 的 skill 列表
dvm.get('/skills', async (c) => {
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

// GET /api/dvm/market — 公开任务列表
dvm.get('/market', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind')
  const statusFilter = c.req.query('status')
  const sortParam = c.req.query('sort') || 'newest'
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const page = parseInt(c.req.query('page') || '1')
  const offset = (page - 1) * limit

  const isAllStatuses = statusFilter === 'all'
  // Map UI tab names to DB status values
  const STATUS_MAP: Record<string, string[]> = {
    open: ['open'],
    processing: ['processing', 'result_available'],
    completed: ['completed'],
    error: ['error', 'cancelled', 'rejected'],
  }
  const statuses = isAllStatuses ? [] : (STATUS_MAP[statusFilter || ''] ?? (statusFilter ? statusFilter.split(',').map(s => s.trim()).filter(Boolean) : ['open']))

  const conditions = [
    eq(dvmJobs.role, 'customer'),
    ...(isAllStatuses ? [] : [inArray(dvmJobs.status, statuses)]),
  ]
  if (kindFilter) {
    const k = parseInt(kindFilter)
    if (k >= 5000 && k <= 5999) conditions.push(eq(dvmJobs.kind, k))
  }

  const whereClause = and(...conditions)
  const orderByClause = sortParam === 'bid_desc' ? desc(dvmJobs.bidMsats) : sortParam === 'bid_asc' ? asc(dvmJobs.bidMsats) : desc(dvmJobs.createdAt)

  const [jobs, countResult] = await Promise.all([
    db.select({
      id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, input: dvmJobs.input,
      inputType: dvmJobs.inputType, output: dvmJobs.output, bidMsats: dvmJobs.bidMsats,
      params: dvmJobs.params, customerPubkey: dvmJobs.customerPubkey, providerPubkey: dvmJobs.providerPubkey,
      createdAt: dvmJobs.createdAt, customerUsername: users.username,
      customerDisplayName: users.displayName, customerAvatarUrl: users.avatarUrl,
    })
      .from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(whereClause).orderBy(orderByClause).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(whereClause),
  ])

  const total = countResult[0]?.count || 0

  return c.json({
    jobs: jobs.map(j => {
      const parsedParams = j.params ? JSON.parse(j.params) : null
      const minZap = parsedParams?.min_zap_sats ? parseInt(parsedParams.min_zap_sats) : undefined
      return {
        id: j.id, kind: j.kind, status: j.status, input: j.input, input_type: j.inputType,
        output: j.output, bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
        ...(minZap ? { min_zap_sats: minZap } : {}), params: parsedParams,
        customer: { username: j.customerUsername, display_name: j.customerDisplayName, avatar_url: j.customerAvatarUrl, pubkey: j.customerPubkey, npub: j.customerPubkey ? pubkeyToNpub(j.customerPubkey) : null },
        provider_pubkey: j.providerPubkey || null, created_at: j.createdAt,
      }
    }),
    meta: paginationMeta(total, page, limit),
  })
})

// GET /api/dvm/history — DVM 历史
dvm.get('/history', async (c) => {
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
    db.select({
      id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, input: dvmJobs.input,
      inputType: dvmJobs.inputType, result: dvmJobs.result, bidMsats: dvmJobs.bidMsats,
      createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
      customerUsername: users.username, customerDisplayName: users.displayName,
      customerAvatarUrl: users.avatarUrl, customerNostrPubkey: users.nostrPubkey,
    })
      .from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(whereClause).orderBy(desc(dvmJobs.updatedAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(dvmJobs).where(whereClause),
  ])

  return c.json({
    jobs: jobs.map(j => ({
      id: j.id, kind: j.kind, status: j.status, input: j.input, input_type: j.inputType,
      result: j.status === 'completed' || j.status === 'result_available' ? j.result : null,
      bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
      customer: { username: j.customerUsername, display_name: j.customerDisplayName, avatar_url: j.customerAvatarUrl, nostr_pubkey: j.customerNostrPubkey },
      created_at: j.createdAt, updated_at: j.updatedAt,
    })),
    meta: paginationMeta(countResult[0]?.count || 0, page, limit),
  })
})

// GET /api/dvm/jobs/:id — 公开任务详情
dvm.get('/jobs/:id', async (c) => {
  const db = c.get('db')
  const jobId = c.req.param('id')

  let job = await db.select().from(dvmJobs).where(eq(dvmJobs.id, jobId)).limit(1)
  if (job.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = job[0]

  const reviews = await db.select({
    id: dvmReviews.id, rating: dvmReviews.rating, content: dvmReviews.content,
    role: dvmReviews.role, reviewerUsername: users.username,
    reviewerDisplayName: users.displayName, createdAt: dvmReviews.createdAt,
  }).from(dvmReviews).leftJoin(users, eq(dvmReviews.reviewerUserId, users.id)).where(eq(dvmReviews.jobId, jobId))

  const isEscrow = !!j.encryptedResult
  const showResult = j.status === 'completed' ? j.result : (isEscrow ? null : j.result)

  return c.json({
    id: j.id, role: j.role, kind: j.kind, status: j.status, input: j.input, input_type: j.inputType,
    output: j.output, result: showResult,
    result_preview: isEscrow && j.status !== 'completed' ? j.resultPreview : undefined,
    result_hash: isEscrow ? j.resultHash : undefined, escrow: isEscrow,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : null,
    price_sats: j.priceMsats ? Math.floor(j.priceMsats / 1000) : null,
    paid_sats: j.paidMsats ? Math.floor(j.paidMsats / 1000) : null,
    payment_method: j.paymentMethod || null,
    customer_pubkey: j.customerPubkey, provider_pubkey: j.providerPubkey,
    request_event_id: j.requestEventId, result_event_id: j.resultEventId,
    params: j.params ? JSON.parse(j.params) : null,
    created_at: j.createdAt, updated_at: j.updatedAt,
    reviews: reviews.map(r => ({ id: r.id, rating: r.rating, content: r.content, role: r.role, reviewer: r.reviewerDisplayName || r.reviewerUsername, created_at: r.createdAt })),
  })
})

// GET /api/dvm/jobs/:id/public — 公开任务详情（只返回 customer job）
dvm.get('/jobs/:id/public', async (c) => {
  const db = c.get('db')
  const jobId = c.req.param('id')

  const result = await db.select({
    id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, input: dvmJobs.input,
    result: dvmJobs.result, bidMsats: dvmJobs.bidMsats, providerPubkey: dvmJobs.providerPubkey,
    createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
    customerName: users.displayName, customerUsername: users.username, customerPubkey: users.nostrPubkey,
  }).from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id))
    .where(and(eq(dvmJobs.id, jobId), eq(dvmJobs.role, 'customer'))).limit(1)

  if (result.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = result[0]
  const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`

  let provider: { name: string | null; username: string | null; npub: string | null } | null = null
  if (j.providerPubkey) {
    const prov = await db.select({ displayName: users.displayName, username: users.username, nostrPubkey: users.nostrPubkey })
      .from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)
    if (prov.length > 0) {
      provider = { name: prov[0].displayName || prov[0].username, username: prov[0].username, npub: prov[0].nostrPubkey ? pubkeyToNpub(prov[0].nostrPubkey) : null }
    } else {
      provider = { name: j.providerPubkey.slice(0, 12) + '...', username: null, npub: pubkeyToNpub(j.providerPubkey) }
    }
  }

  return c.json({
    id: j.id, kind: j.kind, kind_label: kindLabel, status: j.status, input: j.input, result: j.result,
    bid_sats: j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0,
    customer: { name: j.customerName || j.customerUsername, username: j.customerUsername, npub: j.customerPubkey ? pubkeyToNpub(j.customerPubkey) : null },
    provider, created_at: j.createdAt, updated_at: j.updatedAt,
  })
})

// GET /api/dvm/services — 所有活跃服务
dvm.get('/services', async (c) => {
  const db = c.get('db')

  const services = await db.select({
    id: dvmServices.id, kinds: dvmServices.kinds, description: dvmServices.description,
    pricingMin: dvmServices.pricingMin, pricingMax: dvmServices.pricingMax,
    active: dvmServices.active, directRequestEnabled: dvmServices.directRequestEnabled,
    totalZapReceived: dvmServices.totalZapReceived, jobsCompleted: dvmServices.jobsCompleted,
    jobsRejected: dvmServices.jobsRejected, totalEarnedMsats: dvmServices.totalEarnedMsats,
    avgResponseMs: dvmServices.avgResponseMs, lastJobAt: dvmServices.lastJobAt,
    createdAt: dvmServices.createdAt, nostrPubkey: users.nostrPubkey, username: users.username,
  }).from(dvmServices).innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1)).orderBy(desc(dvmServices.createdAt))

  const result = await Promise.all(services.map(async (s) => {
    const wotData = s.nostrPubkey ? await getWotData(db, s.nostrPubkey) : { trusted_by: 0, trusted_by_your_follows: 0 }
    const reviewData = s.nostrPubkey ? await getReviewData(db, s.nostrPubkey) : { avg_rating: 0, review_count: 0 }

    let reportCount = 0
    if (s.nostrPubkey) {
      const rc = await db.select({ count: sql<number>`COUNT(DISTINCT reporter_pubkey)` })
        .from(nostrReports).where(eq(nostrReports.targetPubkey, s.nostrPubkey))
      reportCount = rc[0]?.count || 0
    }

    return {
      id: s.id, username: s.username, kinds: JSON.parse(s.kinds), description: s.description,
      pricing_min_sats: s.pricingMin ? Math.floor(s.pricingMin / 1000) : null,
      pricing_max_sats: s.pricingMax ? Math.floor(s.pricingMax / 1000) : null,
      active: !!s.active, direct_request_enabled: !!s.directRequestEnabled,
      total_zap_received_sats: s.totalZapReceived || 0,
      reputation: buildReputationData(s, wotData, reviewData),
      report_count: reportCount, flagged: reportCount >= REPORT_FLAG_THRESHOLD, created_at: s.createdAt,
    }
  }))

  return c.json({ services: result })
})

// GET /api/dvm/workflows/:id — 工作流详情
dvm.get('/workflows/:id', async (c) => {
  const db = c.get('db')
  const workflowId = c.req.param('id')

  const workflow = await db.select().from(dvmWorkflows).where(eq(dvmWorkflows.id, workflowId)).limit(1)
  if (workflow.length === 0) return c.json({ error: 'Workflow not found' }, 404)

  const steps = await db.select().from(dvmWorkflowSteps)
    .where(eq(dvmWorkflowSteps.workflowId, workflowId)).orderBy(asc(dvmWorkflowSteps.stepIndex))

  return c.json({
    id: workflow[0].id, status: workflow[0].status, description: workflow[0].description,
    total_bid_sats: workflow[0].totalBidSats, current_step: workflow[0].currentStep,
    total_steps: workflow[0].totalSteps, created_at: workflow[0].createdAt, updated_at: workflow[0].updatedAt,
    steps: steps.map(s => ({ step_index: s.stepIndex, kind: s.kind, description: s.description, input: s.input, output: s.output, job_id: s.jobId, provider: s.provider, status: s.status })),
  })
})

// GET /api/dvm/swarm/:id — Swarm 详情
dvm.get('/swarm/:id', async (c) => {
  const db = c.get('db')
  const swarmId = c.req.param('id')

  const swarm = await db.select().from(dvmSwarms).where(eq(dvmSwarms.id, swarmId)).limit(1)
  if (swarm.length === 0) return c.json({ error: 'Swarm not found' }, 404)

  const submissions = await db.select({
    id: dvmSwarmSubmissions.id, providerPubkey: dvmSwarmSubmissions.providerPubkey,
    result: dvmSwarmSubmissions.result, status: dvmSwarmSubmissions.status,
    createdAt: dvmSwarmSubmissions.createdAt, username: users.username, displayName: users.displayName,
  }).from(dvmSwarmSubmissions).leftJoin(users, eq(dvmSwarmSubmissions.providerUserId, users.id))
    .where(eq(dvmSwarmSubmissions.swarmId, swarmId)).orderBy(asc(dvmSwarmSubmissions.createdAt))

  return c.json({
    id: swarm[0].id, job_id: swarm[0].jobId, max_providers: swarm[0].maxProviders,
    judge: swarm[0].judge, status: swarm[0].status, winner_id: swarm[0].winnerId, created_at: swarm[0].createdAt,
    submissions: submissions.map(s => ({
      id: s.id, provider_pubkey: s.providerPubkey, provider_username: s.username,
      provider_display_name: s.displayName, result: s.result, status: s.status, created_at: s.createdAt,
    })),
  })
})

export default dvm
