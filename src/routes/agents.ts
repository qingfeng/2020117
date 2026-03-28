import { Hono } from 'hono'
import { eq, and, sql, desc } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, dvmServices, nostrReports, agentHeartbeats } from '../db/schema'
import { pubkeyToNpub, npubToPubkey } from '../services/nostr'
import { paginationMeta, getWotData, getReviewData, buildReputationData, DVM_KIND_LABELS, REPORT_FLAG_THRESHOLD } from './helpers'

const agents = new Hono<AppContext>()

// GET /api/agents — Agent 列表（KV 缓存）
agents.get('/', async (c) => {
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const source = c.req.query('source')
  const featureFilter = c.req.query('feature')

  const cacheKey = `agents_cache_${source || 'all'}`
  let raw = await c.env.KV.get(cacheKey)

  if (!raw) {
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

  const sortBy = c.req.query('sort') || 'reputation'
  const sortFns: Record<string, (a: any, b: any) => number> = {
    earnings: (a, b) => (b.reputation?.platform?.total_earned_sats || 0) - (a.reputation?.platform?.total_earned_sats || 0),
    jobs: (a, b) => (b.reputation?.platform?.jobs_completed || 0) - (a.reputation?.platform?.jobs_completed || 0),
    rating: (a, b) => (b.reputation?.reviews?.avg_rating || 0) - (a.reputation?.reviews?.avg_rating || 0),
    reputation: () => 0, // already sorted by reputation in cache
  }
  if (sortBy !== 'reputation' && sortFns[sortBy]) {
    allAgents = [...allAgents].sort(sortFns[sortBy])
  }

  const total = allAgents.length
  const offset = (page - 1) * limit
  const agentList = allAgents.slice(offset, offset + limit)
  return c.json({ agents: agentList, meta: paginationMeta(total, page, limit) })
})

// GET /api/agents/online — 在线 Agent 列表
agents.get('/online', async (c) => {
  const db = c.get('db')
  const kindFilter = c.req.query('kind')
  const featureFilter = c.req.query('feature')

  const rows = await db.select({
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

  let agentList = rows.map(r => ({
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

  if (kindFilter) {
    const kind = parseInt(kindFilter)
    agentList = agentList.filter(a => a.kinds.includes(kind))
  }

  if (featureFilter) {
    agentList = agentList.filter(a => {
      if (!a._skill) return false
      try {
        const skill = JSON.parse(a._skill)
        return Array.isArray(skill.features) && skill.features.includes(featureFilter)
      } catch { return false }
    })
  }

  const resultList = agentList.map(({ _skill, ...rest }) => rest)
  return c.json({ agents: resultList, total: resultList.length })
})

// GET /api/agents/:identifier/skill — Agent Skill JSON
agents.get('/:identifier/skill', async (c) => {
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

export default agents
