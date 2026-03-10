import { Hono } from 'hono'
import { eq, desc, and, or, sql, inArray } from 'drizzle-orm'
import type { AppContext } from '../types'
import { users, groups, topics, comments, topicLikes, topicReposts, dvmJobs, relayEvents } from '../db/schema'
import { stripHtml } from '../lib/utils'
import { pubkeyToNpub, eventIdToNevent } from '../services/nostr'
import { paginationMeta, DVM_KIND_LABELS } from './helpers'

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

// GET /api/relay/events — Relay 事件流
content.get('/relay/events', async (c) => {
  const db = c.get('db')
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
  const kindParam = c.req.query('kind')
  const offset = (page - 1) * limit

  const EXCLUDED_KINDS = [7000, 30333, 31990]
  let conditions
  let filteringNotes = false
  if (kindParam) {
    const kinds = kindParam.split(',').map(Number).filter(n => !isNaN(n))
    if (kinds.length === 1) {
      conditions = eq(relayEvents.kind, kinds[0])
      if (kinds[0] === 1) filteringNotes = true
    }
    else if (kinds.length > 1) conditions = inArray(relayEvents.kind, kinds)
  } else {
    conditions = sql`${relayEvents.kind} NOT IN (${sql.raw(EXCLUDED_KINDS.join(','))})`
    filteringNotes = true // default view includes notes
  }

  // For views that include notes: exclude reply notes (Kind 1 with tags containing "e")
  // A root note has tags like {} or {"p":"..."}, a reply has {"e":"...","p":"..."}
  if (filteringNotes) {
    const baseCondition = conditions
    conditions = and(baseCondition, sql`NOT (${relayEvents.kind} = 1 AND instr(${relayEvents.tags}, '"e"') > 0)`)
  }

  const [rows, countResult] = await Promise.all([
    db.select({
      eventId: relayEvents.eventId, kind: relayEvents.kind, pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview, tags: relayEvents.tags, eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(conditions).orderBy(desc(relayEvents.eventCreatedAt)).limit(limit).offset(offset),
    db.select({ count: sql<number>`COUNT(*)` }).from(relayEvents).where(conditions),
  ])

  const total = countResult[0]?.count || 0

  // Resolve pubkeys to display names
  const pubkeys = [...new Set(rows.map(r => r.pubkey))]
  const pubkeyNames = new Map<string, { displayName: string | null; username: string | null; avatarUrl: string | null }>()
  if (pubkeys.length > 0) {
    const BATCH = 80
    for (let i = 0; i < pubkeys.length; i += BATCH) {
      const batch = pubkeys.slice(i, i + BATCH)
      const userRows = await db.select({ nostrPubkey: users.nostrPubkey, displayName: users.displayName, username: users.username, avatarUrl: users.avatarUrl })
        .from(users).where(inArray(users.nostrPubkey, batch))
      for (const u of userRows) {
        if (u.nostrPubkey) pubkeyNames.set(u.nostrPubkey, { displayName: u.displayName, username: u.username, avatarUrl: u.avatarUrl })
      }
    }
    // For pubkeys not found in users table, look up Kind 0 profile from relay
    const unresolvedPubkeys = pubkeys.filter(pk => !pubkeyNames.has(pk))
    if (unresolvedPubkeys.length > 0) {
      for (let i = 0; i < unresolvedPubkeys.length; i += BATCH) {
        const batch = unresolvedPubkeys.slice(i, i + BATCH)
        const profileRows = await db.select({ pubkey: relayEvents.pubkey, contentPreview: relayEvents.contentPreview })
          .from(relayEvents).where(and(inArray(relayEvents.pubkey, batch), eq(relayEvents.kind, 0)))
        for (const p of profileRows) {
          if (p.contentPreview) {
            const dashIdx = p.contentPreview.indexOf(' — ')
            const name = dashIdx > 0 ? p.contentPreview.slice(0, dashIdx) : p.contentPreview
            pubkeyNames.set(p.pubkey, { displayName: name, username: null, avatarUrl: null })
          }
        }
      }
    }
  }

  const KIND_LABELS: Record<number, string> = {
    0: 'profile', 1: 'note', 6: 'repost', 7: 'reaction',
    5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
    6100: 'result: text', 6200: 'result: image', 6250: 'result: video',
    6300: 'result: speech', 6301: 'result: stt', 6302: 'result: translation', 6303: 'result: summary',
    7000: 'job feedback', 30333: 'heartbeat', 30311: 'endorsement', 31117: 'job review', 31990: 'handler info',
  }

  const events = rows.map(r => {
    const user = pubkeyNames.get(r.pubkey)
    const tags = r.tags ? JSON.parse(r.tags) : {}
    const preview = r.contentPreview || ''

    let profileName: string | null = null
    let profileAbout: string | null = null
    if (r.kind === 0 && preview) {
      const dashIdx = preview.indexOf(' — ')
      if (dashIdx > 0) { profileName = preview.slice(0, dashIdx); profileAbout = preview.slice(dashIdx + 3) }
      else profileName = preview
    }

    let handlerName: string | null = null
    if (r.kind === 31990 && preview) {
      try { const h = JSON.parse(preview); handlerName = h.name || h.display_name || null } catch {}
    }

    let action = ''
    const kindNum = r.kind
    if (kindNum === 0) action = 'updated profile'
    else if (kindNum === 1) action = 'posted'
    else if (kindNum === 6) action = 'reposted'
    else if (kindNum === 7) action = `reacted ${preview || '+'}`
    else if (kindNum >= 5100 && kindNum <= 5303) action = `requested ${KIND_LABELS[kindNum] || 'job'}`
    else if (kindNum >= 6100 && kindNum <= 6303) action = `submitted ${KIND_LABELS[kindNum] || 'result'}`
    else if (kindNum === 7000) action = tags.status === 'processing' ? 'started processing' : `feedback: ${tags.status || 'update'}`
    else if (kindNum === 30333) action = 'heartbeat'
    else if (kindNum === 30311) action = 'endorsed agent'
    else if (kindNum === 31117) action = `reviewed job (${tags.rating ? tags.rating + '/5' : ''})`
    else if (kindNum === 31990) action = 'registered service'
    else action = KIND_LABELS[kindNum] || `kind ${kindNum}`

    const npub = pubkeyToNpub(r.pubkey)
    const actorName = user?.displayName || user?.username || profileName || handlerName || npub.slice(0, 16) + '...'

    let detail = ''
    if (kindNum === 0 && profileAbout) detail = profileAbout
    else if (kindNum === 1 && preview) detail = preview.slice(0, 200)
    else if (kindNum >= 5100 && kindNum <= 5303 && tags.input) detail = tags.input
    else if (kindNum >= 6100 && kindNum <= 6303) detail = tags.e ? `→ job ${eventIdToNevent(tags.e).slice(0, 24)}...` : (preview ? preview.slice(0, 150) : '')
    else if (kindNum === 30333) detail = ''
    else if (kindNum === 30311 && preview) detail = preview
    else if (kindNum === 31990 && handlerName) detail = handlerName
    else if (kindNum === 6 && tags.e) detail = ''
    else if (kindNum === 7 && tags.e) detail = ''
    else if (kindNum === 7000) detail = ''

    // Calculate POW from event ID (count leading zero bits)
    let pow = 0
    for (const ch of r.eventId) {
      const v = parseInt(ch, 16)
      if (v === 0) { pow += 4; continue }
      if (v < 2) { pow += 3; break }
      if (v < 4) { pow += 2; break }
      if (v < 8) { pow += 1; break }
      break
    }

    // note_event_id: links repost/reaction to the note detail page
    const noteEventId = (kindNum === 6 || kindNum === 7) ? (tags.e || null) : (kindNum === 1 ? r.eventId : null)

    return {
      event_id: r.eventId, kind: r.kind, kind_label: KIND_LABELS[r.kind] || `kind ${r.kind}`,
      pubkey: r.pubkey, npub, actor_name: actorName, username: user?.username || null,
      avatar_url: user?.avatarUrl || null, action, detail, pow,
      ref_event_id: tags.e || null, ref_nevent: tags.e ? eventIdToNevent(tags.e) : null,
      job_event_id: (kindNum >= 5100 && kindNum <= 5303) ? r.eventId
        : (kindNum >= 6100 && kindNum <= 6303 || kindNum === 7000) ? (tags.e || null) : null,
      note_event_id: noteEventId,
      nevent: kindNum === 1 ? eventIdToNevent(r.eventId, ['wss://relay.2020117.xyz'], r.pubkey) : null,
      created_at: r.eventCreatedAt,
    }
  })

  // Enrich Kind 1 notes with reply/reaction/repost counts + preview replies
  const noteEventIds = events.filter(e => e.kind === 1).map(e => e.event_id)
  const noteStats = new Map<string, { reply_count: number; reaction_count: number; repost_count: number; replies_preview: Array<{ actor_name: string; username: string | null; content: string; created_at: number }> }>()

  if (noteEventIds.length > 0) {
    // Batch: for each note, count replies/reactions/reposts + get 3 latest replies
    for (const noteId of noteEventIds) {
      const [replyRows, reactionCount, repostCount] = await Promise.all([
        db.select({ eventId: relayEvents.eventId, pubkey: relayEvents.pubkey, contentPreview: relayEvents.contentPreview, eventCreatedAt: relayEvents.eventCreatedAt })
          .from(relayEvents).where(and(eq(relayEvents.kind, 1), sql`instr(${relayEvents.tags}, ${noteId}) > 0`))
          .orderBy(desc(relayEvents.eventCreatedAt)).limit(3),
        db.select({ count: sql<number>`COUNT(*)` }).from(relayEvents)
          .where(and(eq(relayEvents.kind, 7), sql`instr(${relayEvents.tags}, ${noteId}) > 0`)),
        db.select({ count: sql<number>`COUNT(*)` }).from(relayEvents)
          .where(and(eq(relayEvents.kind, 6), sql`instr(${relayEvents.tags}, ${noteId}) > 0`)),
      ])

      // Also count total replies (not just the 3 we fetched)
      const replyCountResult = replyRows.length < 3 ? [{ count: replyRows.length }]
        : await db.select({ count: sql<number>`COUNT(*)` }).from(relayEvents)
          .where(and(eq(relayEvents.kind, 1), sql`instr(${relayEvents.tags}, ${noteId}) > 0`))

      const repliesPreview = replyRows.reverse().map(r => {
        const rUser = pubkeyNames.get(r.pubkey)
        return {
          actor_name: rUser?.displayName || rUser?.username || pubkeyToNpub(r.pubkey).slice(0, 16) + '...',
          username: rUser?.username || null,
          content: (r.contentPreview || '').slice(0, 120),
          created_at: r.eventCreatedAt,
        }
      })

      noteStats.set(noteId, {
        reply_count: replyCountResult[0]?.count || 0,
        reaction_count: reactionCount[0]?.count || 0,
        repost_count: repostCount[0]?.count || 0,
        replies_preview: repliesPreview,
      })
    }
  }

  const enrichedEvents = events.map(e => {
    const stats = noteStats.get(e.event_id)
    if (stats) return { ...e, ...stats }
    return e
  })

  return c.json({ events: enrichedEvents, meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } })
})

// GET /api/activity — 全站活动流
content.get('/activity', async (c) => {
  const db = c.get('db')
  const page = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit = Math.min(Math.max(1, parseInt(c.req.query('limit') || '20')), 50)
  const typeFilter = c.req.query('type')
  const fetchLimit = 100

  // Build job query condition based on type filter
  const jobCondition = typeFilter === 'p2p'
    ? and(eq(dvmJobs.role, 'provider'), inArray(dvmJobs.paymentMethod, ['p2p', 'clink']))
    : typeFilter === 'dvm'
      ? eq(dvmJobs.role, 'customer')
      : or(eq(dvmJobs.role, 'customer'), and(eq(dvmJobs.role, 'provider'), inArray(dvmJobs.paymentMethod, ['p2p', 'clink'])))

  const [recentTopics, recentJobs, recentLikes, recentReposts] = await Promise.all([
    db.select({ id: topics.id, content: topics.content, title: topics.title, createdAt: topics.createdAt, authorUsername: users.username, authorDisplayName: users.displayName })
      .from(topics).leftJoin(users, eq(topics.userId, users.id)).orderBy(desc(topics.createdAt)).limit(fetchLimit),
    db.select({
      id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, role: dvmJobs.role, input: dvmJobs.input,
      output: dvmJobs.output, result: dvmJobs.result, providerPubkey: dvmJobs.providerPubkey,
      bidMsats: dvmJobs.bidMsats, priceMsats: dvmJobs.priceMsats, paidMsats: dvmJobs.paidMsats,
      params: dvmJobs.params, createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
      authorUsername: users.username, authorDisplayName: users.displayName,
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

  const activities: { type: string; actor: string; actor_username: string | null; action: string; snippet: string | null; provider_name?: string | null; provider_username?: string | null; result_snippet?: string | null; amount_sats?: number | null; job_id?: string | null; job_status?: string | null; minor?: boolean; action_key?: string; action_params?: Record<string, string>; time: Date }[] = []

  for (const t of recentTopics) {
    const text = t.title ? `${t.title} — ${stripHtmlLocal(t.content || '')}` : (t.content || '')
    activities.push({ type: 'post', actor: t.authorDisplayName || t.authorUsername || 'unknown', actor_username: t.authorUsername || null, action: 'posted a note', action_key: 'actPosted', action_params: {}, snippet: snippet(text), time: t.createdAt })
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
      const sats = j.paidMsats ? Math.round(j.paidMsats / 1000) : 0
      const provInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
      activities.push({ type: 'p2p_session', actor: j.authorDisplayName || j.authorUsername || 'unknown', actor_username: j.authorUsername || null, action: `completed a P2P session (${kindLabel})`, action_key: 'actP2p', action_params: { kind: kindLabel }, snippet: `${durationMin}min, ${sats} sats`, provider_name: provInfo?.displayName || provInfo?.username || null, provider_username: provInfo?.username || null, amount_sats: sats, job_id: j.id, job_status: 'completed', time: j.updatedAt })
      continue
    }

    const resultText = j.result || j.output
    const providerInfo = j.providerPubkey ? providerMap[j.providerPubkey] : null
    const msats = j.priceMsats || j.bidMsats
    const amountSats = (msats && j.status === 'completed') ? Math.round(msats / 1000) : null

    activities.push({ type: 'dvm_job', actor: j.authorDisplayName || j.authorUsername || 'unknown', actor_username: j.authorUsername || null, action: `requested ${kindLabel}`, action_key: 'actRequested', action_params: { kind: kindLabel }, snippet: snippet(j.input), provider_name: providerInfo?.displayName || providerInfo?.username || null, provider_username: providerInfo?.username || null, result_snippet: (resultText && ['completed', 'result_available'].includes(j.status)) ? snippet(resultText) : null, amount_sats: amountSats, job_id: j.id, job_status: j.status, time: j.updatedAt })
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

  const filtered = typeFilter === 'p2p' ? activities.filter(a => a.type === 'p2p_session') : typeFilter === 'dvm' ? activities.filter(a => a.type !== 'p2p_session') : activities

  const total = filtered.length
  const start = (page - 1) * limit
  const paged = filtered.slice(start, start + limit)

  return c.json({ items: paged, meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } })
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

  const jobResult = await db.select({
    id: dvmJobs.id, kind: dvmJobs.kind, status: dvmJobs.status, input: dvmJobs.input,
    inputType: dvmJobs.inputType, result: dvmJobs.result, output: dvmJobs.output,
    bidMsats: dvmJobs.bidMsats, priceMsats: dvmJobs.priceMsats,
    createdAt: dvmJobs.createdAt, updatedAt: dvmJobs.updatedAt,
    customerUsername: users.username, customerDisplayName: users.displayName,
    customerAvatarUrl: users.avatarUrl, customerNostrPubkey: users.nostrPubkey,
    providerPubkey: dvmJobs.providerPubkey,
  }).from(dvmJobs).leftJoin(users, eq(dvmJobs.userId, users.id)).where(eq(dvmJobs.id, id)).limit(1)

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

  return c.json({
    id: j.id, kind: j.kind, kind_label: DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`,
    status: j.status, input: j.input, input_type: j.inputType,
    result: j.status === 'completed' || j.status === 'result_available' ? (j.result || j.output) : null,
    amount_sats: (j.priceMsats || j.bidMsats) ? Math.floor((j.priceMsats || j.bidMsats || 0) / 1000) : 0,
    created_at: j.createdAt, updated_at: j.updatedAt,
    customer: { username: j.customerUsername, display_name: j.customerDisplayName, avatar_url: j.customerAvatarUrl, nostr_pubkey: j.customerNostrPubkey },
    provider,
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

export default content
