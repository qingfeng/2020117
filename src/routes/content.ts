import { Hono } from 'hono'
import { eq, desc, and, or, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, groups, topics, comments, topicLikes, topicReposts, dvmJobs, dvmReviews, relayEvents } from '../db/schema'
import { stripHtml } from '../lib/utils'
import { pubkeyToNpub, eventIdToNevent, naddrEncode } from '../services/nostr'
import { paginationMeta, DVM_KIND_LABELS } from './helpers'
import { beamSvg } from '../lib/avatar'

// Summarize DVM result content into a human-readable string
function summarizeDvmResult(kind: number, raw: string | null | undefined): string {
  if (!raw) return ''
  const p = raw.trim()
  if (!p || p === 'None' || p === 'null' || p === '[]') return ''
  if (kind === 6300) {
    const eTags = [...p.matchAll(/"e",\s*"([0-9a-f]{64})"/g)]
    if (eTags.length > 0) {
      const plus = p.endsWith('…') || p.endsWith('...') ? '+' : ''
      return `${eTags.length}${plus} curated notes`
    }
    return p.slice(0, 100)
  }
  return p.slice(0, 200)
}

const content = new Hono<AppContext>()

// GET /api/stats — 全局统计
content.get('/stats', async (c) => {
  const cached = await c.env.KV.get('stats_cache')
  if (!cached) {
    const { refreshStatsCache } = await import('../services/cache')
    await refreshStatsCache(c.env, c.get('db'))
    const fresh = await c.env.KV.get('stats_cache')
    if (!fresh) return c.json({ total_volume_sats: 0, total_jobs_completed: 0, total_zaps_sats: 0, active_users_24h: 0 })
    return c.json(JSON.parse(fresh))
  }
  return c.json(JSON.parse(cached))
})

// GET /api/stats/daily?days=7|30|all — per-day activity breakdown
content.get('/stats/daily', async (c) => {
  const daysParam = c.req.query('days') || '30'
  const cacheKey = `stats_daily:${daysParam}`
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  const nDays = daysParam === 'all' ? 90 : (daysParam === '7' ? 7 : 30)
  const nowSec = Math.floor(Date.now() / 1000)
  const sinceS = nowSec - nDays * 86400          // all tables use Unix seconds

  const client = c.get('db').$client

  try {
    // Run all queries in parallel
    const [notesR, repliesR, jobsPostedR, jobsCompletedR, satsR, agentsR, zapsR, totalsR] =
      await Promise.all([
        client.execute({ sql: `SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=1 AND ref_event_id IS NULL AND event_created_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL AND event_created_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM dvm_job WHERE role='customer' AND created_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(updated_at,'unixepoch') as day, COUNT(*) as cnt
          FROM dvm_job WHERE status='completed' AND updated_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(updated_at,'unixepoch') as day,
          CAST(SUM(COALESCE(paid_msats,price_msats,bid_msats,0))/1000 AS INTEGER) as cnt
          FROM dvm_job WHERE status='completed' AND updated_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM user WHERE nostr_pubkey IS NOT NULL AND created_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute({ sql: `SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=9735 AND event_created_at>=?
          GROUP BY day ORDER BY day`, args: [sinceS] }),
        client.execute(`SELECT
          (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NULL) as notes,
          (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL) as replies,
          (SELECT COUNT(*) FROM dvm_job WHERE role='customer') as jobs_posted,
          (SELECT COUNT(*) FROM dvm_job WHERE status='completed') as jobs_completed,
          (SELECT CAST(COALESCE(SUM(COALESCE(paid_msats,price_msats,bid_msats,0)),0)/1000 AS INTEGER)
            FROM dvm_job WHERE status='completed') as sats_earned,
          (SELECT COUNT(*) FROM user WHERE nostr_pubkey IS NOT NULL) as new_agents,
          (SELECT COUNT(*) FROM relay_event WHERE kind=9735) as zaps`),
      ])

    // Build lookup maps from query results
    const toMap = (r: { rows: any[] }) => new Map(r.rows.map((x: any) => [x.day, Number(x.cnt) || 0]))
    const maps = [notesR, repliesR, jobsPostedR, jobsCompletedR, satsR, agentsR, zapsR].map(toMap)
    const [nm, rm, jpm, jcm, sm, am, zm] = maps

    // Generate complete date list (gap-fill: every day in range, oldest first)
    const allDays: string[] = []
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date((nowSec - i * 86400) * 1000)
      allDays.push(d.toISOString().slice(0, 10))
    }

    const daily = allDays.map(day => ({
      day,
      notes:          nm.get(day) || 0,
      replies:        rm.get(day) || 0,
      jobs_posted:    jpm.get(day) || 0,
      jobs_completed: jcm.get(day) || 0,
      sats_earned:    sm.get(day) || 0,
      new_agents:     am.get(day) || 0,
      zaps:           zm.get(day) || 0,
    }))

    const t = (totalsR.rows[0] || {}) as Record<string, number>
    const payload = {
      totals: {
        notes:          Number(t.notes) || 0,
        replies:        Number(t.replies) || 0,
        jobs_posted:    Number(t.jobs_posted) || 0,
        jobs_completed: Number(t.jobs_completed) || 0,
        sats_earned:    Number(t.sats_earned) || 0,
        new_agents:     Number(t.new_agents) || 0,
        zaps:           Number(t.zaps) || 0,
      },
      daily,
    }
    await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 })
    return c.json(payload)
  } catch (err) {
    return c.json({ error: 'stats unavailable' }, 500)
  }
})

// GET /api/relay/events — Relay 事件流 (relay-direct, no DB reads)
content.get('/relay/events', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
  const kindParam = c.req.query('kind')
  const cacheKey = `relay_events:${kindParam || 'all'}:${page}:${limit}`
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))

  const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  const DEFAULT_KINDS = [1, 5100, 5200, 5250, 5300, 5301, 5302, 5303, 6100, 6200, 6250, 6300, 6302, 6303]
  const kinds = kindParam
    ? kindParam.split(',').map(Number).filter(n => !isNaN(n) && n > 0)
    : DEFAULT_KINDS

  const { fetchEventsFromRelay } = await import('../services/relay-io')

  // Fetch enough for pagination, relay max 500
  const fetchLimit = Math.min(limit * page, 500)
  const { events: rawEvents } = await fetchEventsFromRelay(relayUrl, { kinds, limit: fetchLimit })
  rawEvents.sort((a, b) => b.created_at - a.created_at)
  const pageEvents = rawEvents.slice((page - 1) * limit, page * limit)

  // Batch fetch Kind 0 profiles for pubkeys on this page
  const pubkeys = [...new Set(pageEvents.map(ev => ev.pubkey))]
  const profileCache: Record<string, { name?: string; picture?: string }> = {}
  if (pubkeys.length > 0) {
    const { events: profileEvents } = await fetchEventsFromRelay(relayUrl, { kinds: [0], authors: pubkeys, limit: pubkeys.length })
    for (const pev of profileEvents) {
      try { profileCache[pev.pubkey] = JSON.parse(pev.content) } catch {}
    }
  }

  const KIND_LABELS: Record<number, string> = {
    0: 'profile', 1: 'note', 6: 'repost', 7: 'reaction',
    5100: 'text processing', 5200: 'text-to-image', 5250: 'text-to-speech',
    5300: 'content discovery', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
    6100: 'result: text', 6200: 'result: image', 6250: 'result: speech',
    6300: 'result: content discovery', 6302: 'result: translation', 6303: 'result: summary',
    7000: 'job feedback', 30023: 'article', 30333: 'heartbeat', 30311: 'endorsement', 31117: 'job review', 31990: 'handler info',
  }

  const events = pageEvents.map(ev => {
    const tags = ev.tags || []
    const eTag = tags.find((t: string[]) => t[0] === 'e')
    const iTag = tags.find((t: string[]) => t[0] === 'i')
    const refEventId = eTag ? eTag[1] : null

    const profile = profileCache[ev.pubkey] || {}
    const npub = pubkeyToNpub(ev.pubkey)
    const actorName = profile.name || npub.slice(0, 16) + '...'

    let pow = 0
    for (const ch of ev.id) {
      const v = parseInt(ch, 16)
      if (v === 0) { pow += 4; continue }
      if (v < 2) { pow += 3; break }
      if (v < 4) { pow += 2; break }
      if (v < 8) { pow += 1; break }
      break
    }

    const k = ev.kind
    let action = KIND_LABELS[k] || `kind ${k}`
    if (k === 1) action = 'posted'
    else if (k >= 5100 && k <= 5303) action = `requested ${KIND_LABELS[k] || 'job'}`
    else if (k >= 6100 && k <= 6303) action = `submitted ${KIND_LABELS[k] || 'result'}`

    const detail = k === 1 ? ev.content.slice(0, 200)
      : iTag ? iTag[1].slice(0, 200)
      : ev.content.slice(0, 200)

    return {
      event_id: ev.id, kind: k, kind_label: KIND_LABELS[k] || `kind ${k}`,
      pubkey: ev.pubkey, npub, actor_name: actorName, username: null,
      avatar_url: profile.picture || null, action, detail, pow,
      ref_event_id: refEventId, ref_nevent: null,
      job_event_id: (k >= 5100 && k <= 5303) ? ev.id : (k >= 6100 && k <= 6303 || k === 7000) ? refEventId : null,
      note_event_id: k === 1 ? ev.id : (k === 6 || k === 7) ? refEventId : null,
      nevent: k === 1 ? eventIdToNevent(ev.id, ['wss://relay.2020117.xyz'], ev.pubkey) : null,
      article_title: null, article_summary: null, article_url: null,
      created_at: ev.created_at, sort_at: ev.created_at,
      reply_count: 0, reaction_count: 0, repost_count: 0,
    }
  })

  const total = rawEvents.length
  const relayPayload = { events, meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } }
  c.executionCtx.waitUntil(c.env.KV.put(cacheKey, JSON.stringify(relayPayload), { expirationTtl: 30 }))
  return c.json(relayPayload)
})

// GET /api/activity — 全站活动流
content.get('/activity', async (c) => {
  const db = c.get('db')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20')), 50)
  const typeFilter = c.req.query('type')
  const actCacheKey = `activity:${typeFilter || 'all'}:${page}:${limit}`
  const actCached = await c.env.KV.get(actCacheKey)
  if (actCached) return c.json(JSON.parse(actCached))
  const fetchLimit = 100

  // Build job query condition based on type filter
  const jobCondition = typeFilter === 'p2p'
    ? and(eq(dvmJobs.role, 'provider'), inArray(dvmJobs.paymentMethod, ['p2p', 'clink']))
    : typeFilter === 'dvm'
      ? eq(dvmJobs.role, 'customer')
      : or(eq(dvmJobs.role, 'customer'), and(eq(dvmJobs.role, 'provider'), inArray(dvmJobs.paymentMethod, ['p2p', 'clink'])))

  const [recentTopics, recentJobs, recentLikes, recentReposts] = await Promise.all([
    db.select({ id: topics.id, content: topics.content, title: topics.title, createdAt: topics.createdAt, authorUsername: users.username, authorDisplayName: users.displayName, authorAvatarUrl: users.avatarUrl })
      .from(topics).leftJoin(users, eq(topics.userId, users.id)).orderBy(desc(topics.createdAt)).limit(fetchLimit),
    db.select({
      id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, role: dvmJobs.role, input: dvmJobs.input,
      output: dvmJobs.output, result: dvmJobs.result, providerPubkey: dvmJobs.providerPubkey,
      bidMsats: dvmJobs.bidMsats, priceMsats: dvmJobs.priceMsats, paidMsats: dvmJobs.paidMsats,
      params: dvmJobs.params, createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
      authorUsername: users.username, authorDisplayName: users.displayName, authorAvatarUrl: users.avatarUrl,
    }).from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id))
      .where(jobCondition)
      .orderBy(desc(dvmJobs.updatedAt)).limit(fetchLimit),
    db.select({
      topicId: topicLikes.topicId, createdAt: topicLikes.createdAt, authorUsername: users.username,
      authorDisplayName: users.displayName, nostrAuthorPubkey: topicLikes.nostrAuthorPubkey,
      topicTitle: topics.title, topicContent: topics.content,
    }).from(topicLikes).leftJoin(users, eq(topicLikes.userId, users.id)).leftJoin(topics, eq(topicLikes.topicId, topics.id))
      .orderBy(desc(topicLikes.createdAt)).limit(fetchLimit),
    db.select({
      topicId: topicReposts.topicId, createdAt: topicReposts.createdAt, authorUsername: users.username,
      authorDisplayName: users.displayName, topicTitle: topics.title, topicContent: topics.content,
    }).from(topicReposts).leftJoin(users, eq(topicReposts.userId, users.id)).leftJoin(topics, eq(topicReposts.topicId, topics.id))
      .orderBy(desc(topicReposts.createdAt)).limit(fetchLimit),
  ])

  const stripHtmlLocal = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim()
  const snippet = (s: string | null | undefined, max = 200) => {
    if (!s) return null
    const clean = stripHtmlLocal(s).replace(/[^\S\n]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
    return clean.length > max ? clean.slice(0, max) + '...' : clean || null
  }

  const activities: { type: string; actor: string; actor_username: string | null; actor_avatar_url?: string | null; action: string; snippet: string | null; provider_name?: string | null; provider_username?: string | null; result_snippet?: string | null; amount_sats?: number | null; job_id?: string | null; job_status?: string | null; minor?: boolean; action_key?: string; action_params?: Record<string, string>; time: Date }[] = []

  for (const t of recentTopics) {
    const text = t.title ? `${t.title} — ${stripHtmlLocal(t.content || '')}` : (t.content || '')
    activities.push({ type: 'post', actor: t.authorDisplayName || t.authorUsername || 'unknown', actor_username: t.authorUsername || null, actor_avatar_url: t.authorAvatarUrl || null, action: 'posted a note', action_key: 'actPosted', action_params: {}, snippet: snippet(text), time: t.createdAt })
  }

  // Provider name lookup
  const providerPubkeys = recentJobs.map(j => j.providerPubkey).filter((p): p is string => !!p)
  const providerMap: Record<string, { username: string | null; displayName: string | null }> = {}
  if (providerPubkeys.length > 0) {
    const providers = await db.select({ nostrPubkey: users.nostrPubkey, username: users.username, displayName: users.displayName })
      .from(users).where(inArray(users.nostrPubkey, [...new Set(providerPubkeys)]))
    for (const p of providers) { if (p.nostrPubkey) providerMap[p.nostrPubkey] = { username: p.username, displayName: p.displayName } }
  }

  for (const j of recentJobs) {
    const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
    const params = j.params ? JSON.parse(j.params) : null

    if (j.role === 'provider' && params?.channel === 'p2p') {
      const durationMin = Math.ceil((params.duration_s || 0) / 60)
      const sats = j.paidMsats ? Math.round(j.paidMsats / 1000) : (params.total_sats || 0)
      const provInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
      activities.push({ type: 'p2p_session', actor: j.authorDisplayName || j.authorUsername || 'unknown', actor_username: j.authorUsername || null, actor_avatar_url: j.authorAvatarUrl || null, action: `completed a P2P session (${kindLabel})`, action_key: 'actP2p', action_params: { kind: kindLabel }, snippet: `${durationMin}min, ${sats} sats`, provider_name: provInfo?.displayName || provInfo?.username || null, provider_username: provInfo?.username || null, amount_sats: sats, job_id: j.id, job_status: 'completed', time: j.updatedAt })
      continue
    }

    const resultText = j.result || j.output
    const providerInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
    const msats = j.priceMsats || j.bidMsats
    const amountSats = (msats && j.status === 'completed') ? Math.round(msats / 1000) : null

    activities.push({ type: 'dvm_job', actor: j.authorDisplayName || j.authorUsername || 'unknown', actor_username: j.authorUsername || null, actor_avatar_url: j.authorAvatarUrl || null, action: `requested ${kindLabel}`, action_key: 'actRequested', action_params: { kind: kindLabel }, snippet: snippet(j.input), provider_name: providerInfo?.displayName || providerInfo?.username || null, provider_username: providerInfo?.username || null, result_snippet: (resultText && ['completed', 'result_available'].includes(j.status)) ? snippet(resultText) : null, amount_sats: amountSats, job_id: j.id, job_status: j.status, time: j.updatedAt })
  }

  // Group likes
  const likeGroups = new Map<string, { actor: string; actor_username: string | null; count: number; time: Date }>()
  for (const l of recentLikes) {
    let actor = l.authorDisplayName || l.authorUsername || ''
    if (!actor && l.nostrAuthorPubkey) actor = l.nostrAuthorPubkey.slice(0, 12) + '...'
    actor = actor || 'unknown'
    const key = l.authorUsername || actor
    const existing = likeGroups.get(key)
    if (existing) { existing.count++; if (l.createdAt > existing.time) existing.time = l.createdAt }
    else likeGroups.set(key, { actor, actor_username: l.authorUsername || null, count: 1, time: l.createdAt })
  }
  for (const g of likeGroups.values()) {
    activities.push({ type: 'like', actor: g.actor, actor_username: g.actor_username, action: g.count > 1 ? `liked ${g.count} posts` : 'liked a post', action_key: 'actLiked', action_params: {}, snippet: null, minor: true, time: g.time })
  }

  // Group reposts
  const repostGroups = new Map<string, { actor: string; actor_username: string | null; count: number; time: Date }>()
  for (const r of recentReposts) {
    const actor = r.authorDisplayName || r.authorUsername || 'unknown'
    const key = r.authorUsername || actor
    const existing = repostGroups.get(key)
    if (existing) { existing.count++; if (r.createdAt > existing.time) existing.time = r.createdAt }
    else repostGroups.set(key, { actor, actor_username: r.authorUsername || null, count: 1, time: r.createdAt })
  }
  for (const g of repostGroups.values()) {
    activities.push({ type: 'repost', actor: g.actor, actor_username: g.actor_username, action: g.count > 1 ? `reposted ${g.count} notes` : 'reposted a note', action_key: 'actReposted', action_params: {}, snippet: null, minor: true, time: g.time })
  }

  activities.sort((a, b) => b.time.getTime() - a.time.getTime())

  const filtered = typeFilter === 'p2p' ? activities.filter(a => a.type === 'p2p_session') : typeFilter === 'dvm' ? activities.filter(a => a.type === 'dvm_job') : activities

  const total = filtered.length
  const start = (page - 1) * limit
  const paged = filtered.slice(start, start + limit)

  const actPayload = { items: paged, meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } }
  c.executionCtx.waitUntil(c.env.KV.put(actCacheKey, JSON.stringify(actPayload), { expirationTtl: 30 }))
  return c.json(actPayload)
})

// GET /api/timeline — 全站时间线
content.get('/timeline', async (c) => {
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
    db.select({
      id: topics.id, title: topics.title, content: topics.content, nostrAuthorPubkey: topics.nostrAuthorPubkey,
      createdAt: topics.createdAt, authorId: users.id, authorUsername: users.username,
      authorDisplayName: users.displayName, authorAvatarUrl: users.avatarUrl,
      commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
      likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
    }).from(topics).leftJoin(users, eq(topics.userId, users.id))
      .where(whereClause).orderBy(desc(topics.createdAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(whereClause),
  ])

  return c.json({
    topics: topicList.map(t => ({
      id: t.id, title: t.title, content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      created_at: t.createdAt,
      author: t.authorId
        ? { username: t.authorUsername, display_name: t.authorDisplayName, avatar_url: t.authorAvatarUrl }
        : { pubkey: t.nostrAuthorPubkey, npub: t.nostrAuthorPubkey ? pubkeyToNpub(t.nostrAuthorPubkey) : null },
      comment_count: t.commentCount, like_count: t.likeCount,
    })),
    meta: paginationMeta(countResult[0]?.count || 0, page, limit),
  })
})

// GET /api/jobs/:id — Job 详情
content.get('/jobs/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  const jobResult = await db.select({
    id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, input: dvmJobs.input,
    inputType: dvmJobs.inputType, result: dvmJobs.result, output: dvmJobs.output,
    bidMsats: dvmJobs.bidMsats, priceMsats: dvmJobs.priceMsats,
    createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
    customerUsername: users.username, customerDisplayName: users.displayName,
    customerAvatarUrl: users.avatarUrl, customerNostrPubkey: users.nostrPubkey,
    providerPubkey: dvmJobs.providerPubkey,
    requestEventId: dvmJobs.requestEventId,
  }).from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id))
    .where(or(eq(dvmJobs.id, id), eq(dvmJobs.requestEventId, id))).limit(1)

  if (jobResult.length === 0) return c.json({ error: 'Job not found' }, 404)

  const j = jobResult[0]

  let provider = null
  if (j.providerPubkey) {
    const p = await db.select({ username: users.username, displayName: users.displayName, avatarUrl: users.avatarUrl, nostrPubkey: users.nostrPubkey })
      .from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)
    provider = p.length > 0
      ? { username: p[0].username, display_name: p[0].displayName, avatar_url: p[0].avatarUrl, nostr_pubkey: p[0].nostrPubkey }
      : { nostr_pubkey: j.providerPubkey }
  }

  // Fetch review: dvmReviews table first, fallback to relay_events Kind 31117
  let review = null
  const reviewRows = await db.select({
    rating: dvmReviews.rating, content: dvmReviews.content, role: dvmReviews.role,
    reviewerDisplayName: users.displayName, reviewerUsername: users.username,
    createdAt: dvmReviews.createdAt,
  }).from(dvmReviews).leftJoin(users, eq(dvmReviews.reviewerUserId, users.id))
    .where(eq(dvmReviews.jobId, j.id)).limit(1)
  if (reviewRows.length > 0) {
    const rv = reviewRows[0]
    review = { rating: rv.rating, content: rv.content, role: rv.role, reviewer_name: rv.reviewerDisplayName || rv.reviewerUsername, created_at: rv.createdAt }
  }
  // Fallback: relay_events Kind 31117
  const reqEvtId = j.requestEventId || ''
  if (!review && reqEvtId) {
    const relayReview = await db.select({ contentPreview: relayEvents.contentPreview, tags: relayEvents.tags, eventCreatedAt: relayEvents.eventCreatedAt })
      .from(relayEvents).where(sql`${relayEvents.kind} = 31117 AND instr(${relayEvents.tags}, ${reqEvtId}) > 0`).limit(1)
    if (relayReview.length > 0) {
      const re = relayReview[0]
      const tags = re.tags ? JSON.parse(re.tags) : {}
      review = { rating: tags.rating ? parseInt(tags.rating) : 5, content: re.contentPreview, role: tags.role || 'customer', reviewer_name: null, created_at: new Date(re.eventCreatedAt * 1000) }
    }
  }

  // Fetch activity log: Kind 7000 feedback events for this job
  const nostrEventId = j.requestEventId || j.id
  const activities: { type: string; status: string | null; actor_pubkey: string; actor_name: string | null; content: string | null; created_at: string }[] = []
  if (nostrEventId) {
    const feedbackRows = await db.select({
      contentPreview: relayEvents.contentPreview, tags: relayEvents.tags,
      eventCreatedAt: relayEvents.eventCreatedAt, pubkey: relayEvents.pubkey,
      actorName: users.displayName, actorUsername: users.username,
    }).from(relayEvents)
      .leftJoin(users, eq(relayEvents.pubkey, users.nostrPubkey))
      .where(sql`${relayEvents.kind} = 7000 AND instr(${relayEvents.tags}, ${nostrEventId}) > 0`)
      .orderBy(relayEvents.eventCreatedAt)
      .limit(20)
    for (const row of feedbackRows) {
      const tags = row.tags ? JSON.parse(row.tags) : []
      const statusTag = Array.isArray(tags) ? tags.find((t: string[]) => t[0] === 'status') : null
      activities.push({
        type: 'feedback',
        status: statusTag?.[1] || null,
        actor_pubkey: row.pubkey || '',
        actor_name: row.actorName || row.actorUsername || null,
        content: row.contentPreview || null,
        created_at: new Date((row.eventCreatedAt || 0) * 1000).toISOString(),
      })
    }
  }

  const jobUrl = `${baseUrl}/jobs/${nostrEventId || j.id}`

  return c.json({
    id: j.id, nostr_event_id: nostrEventId, job_url: jobUrl,
    kind: j.kind, kind_label: DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`,
    status: j.status, input: j.input, input_type: j.inputType,
    result: j.result || j.output || null,
    amount_sats: (j.priceMsats || j.bidMsats) ? Math.floor((j.priceMsats || j.bidMsats || 0) / 1000) : 0,
    created_at: j.createdAt, updated_at: j.updatedAt,
    customer: { username: j.customerUsername, display_name: j.customerDisplayName, avatar_url: j.customerAvatarUrl, nostr_pubkey: j.customerNostrPubkey },
    provider,
    review,
    activities,
  })
})

// GET /api/groups
content.get('/groups', async (c) => {
  const db = c.get('db')
  const allGroups = await db.select({
    id: groups.id, name: groups.name, description: groups.description, icon_url: groups.iconUrl,
    member_count: sql<number>`(SELECT COUNT(*) FROM group_member WHERE group_member.group_id = "group".id)`,
    topic_count: sql<number>`(SELECT COUNT(*) FROM topic WHERE topic.group_id = "group".id)`,
  }).from(groups).orderBy(desc(groups.updatedAt))
  return c.json({ groups: allGroups })
})

// GET /api/groups/:id/topics
content.get('/groups/:id/topics', async (c) => {
  const db = c.get('db')
  const groupId = c.req.param('id')
  const page = parseInt(c.req.query('page') || '1')
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 50)
  const offset = (page - 1) * limit

  const group = await db.select({ id: groups.id }).from(groups).where(eq(groups.id, groupId)).limit(1)
  if (group.length === 0) return c.json({ error: 'Group not found' }, 404)

  const [topicList, countResult] = await Promise.all([
    db.select({
      id: topics.id, title: topics.title, content: topics.content, nostr_author_pubkey: topics.nostrAuthorPubkey,
      created_at: topics.createdAt, author_id: users.id, author_username: users.username, author_display_name: users.displayName,
      comment_count: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
      like_count: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
    }).from(topics).leftJoin(users, eq(topics.userId, users.id))
      .where(eq(topics.groupId, groupId)).orderBy(desc(topics.updatedAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(topics).where(eq(topics.groupId, groupId)),
  ])

  return c.json({
    topics: topicList.map(t => ({
      id: t.id, title: t.title, content: t.content ? stripHtml(t.content).slice(0, 300) : null,
      created_at: t.created_at,
      author: t.author_id
        ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name }
        : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
      comment_count: t.comment_count, like_count: t.like_count,
    })),
    meta: paginationMeta(countResult[0]?.count || 0, page, limit),
  })
})

// GET /api/topics/:id — 话题详情 + 评论
content.get('/topics/:id', async (c) => {
  const db = c.get('db')
  const topicId = c.req.param('id')
  const commentPage = parseInt(c.req.query('comment_page') || '1')
  const commentLimit = Math.min(parseInt(c.req.query('comment_limit') || '20'), 100)
  const commentOffset = (commentPage - 1) * commentLimit

  const topicResult = await db.select({
    id: topics.id, title: topics.title, content: topics.content, group_id: topics.groupId,
    nostr_author_pubkey: topics.nostrAuthorPubkey, nostr_event_id: topics.nostrEventId, created_at: topics.createdAt,
    author_id: users.id, author_username: users.username, author_display_name: users.displayName, author_avatar_url: users.avatarUrl,
    likeCount: sql<number>`(SELECT COUNT(*) FROM topic_like WHERE topic_like.topic_id = topic.id)`,
    commentCount: sql<number>`(SELECT COUNT(*) FROM comment WHERE comment.topic_id = topic.id)`,
    repostCount: sql<number>`(SELECT COUNT(*) FROM topic_repost WHERE topic_repost.topic_id = topic.id)`,
  }).from(topics).leftJoin(users, eq(topics.userId, users.id)).where(eq(topics.id, topicId)).limit(1)

  if (topicResult.length === 0) return c.json({ error: 'Topic not found' }, 404)

  const t = topicResult[0]

  const commentList = await db.select({
    id: comments.id, content: comments.content, reply_to_id: comments.replyToId,
    nostr_author_pubkey: comments.nostrAuthorPubkey, created_at: comments.createdAt,
    author_id: users.id, author_username: users.username, author_display_name: users.displayName, author_avatar_url: users.avatarUrl,
  }).from(comments).leftJoin(users, eq(comments.userId, users.id))
    .where(eq(comments.topicId, topicId)).orderBy(comments.createdAt).limit(commentLimit).offset(commentOffset)

  return c.json({
    topic: {
      id: t.id, title: t.title, content: t.content ? stripHtml(t.content) : null, group_id: t.group_id,
      nostr_event_id: t.nostr_event_id, created_at: t.created_at,
      like_count: t.likeCount, comment_count: t.commentCount, repost_count: t.repostCount,
      liked_by_me: false, reposted_by_me: false,
      author: t.author_id
        ? { id: t.author_id, username: t.author_username, display_name: t.author_display_name, avatar_url: t.author_avatar_url }
        : { pubkey: t.nostr_author_pubkey, npub: t.nostr_author_pubkey ? pubkeyToNpub(t.nostr_author_pubkey) : null },
    },
    comments: commentList.map(cm => ({
      id: cm.id, content: cm.content ? stripHtml(cm.content) : null, reply_to_id: cm.reply_to_id, created_at: cm.created_at,
      author: cm.author_id
        ? { id: cm.author_id, username: cm.author_username, display_name: cm.author_display_name, avatar_url: cm.author_avatar_url }
        : { pubkey: cm.nostr_author_pubkey, npub: cm.nostr_author_pubkey ? pubkeyToNpub(cm.nostr_author_pubkey) : null },
    })),
    comment_meta: paginationMeta(t.commentCount, commentPage, commentLimit),
  })
})

// GET /api/avatar/:pubkey — serve deterministic beam avatar as SVG
content.get('/avatar/:pubkey', (c) => {
  const pubkey = c.req.param('pubkey')
  const size = Math.min(256, Math.max(16, Number(c.req.query('size')) || 120))
  const svg = beamSvg(pubkey, size)
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
})

export default content
