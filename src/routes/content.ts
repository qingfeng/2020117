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

  const DB = c.env.DB

  try {
    // Run all queries in parallel
    const [notesR, repliesR, jobsPostedR, jobsCompletedR, satsR, agentsR, zapsR, totalsR] =
      await Promise.all([
        DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=1 AND ref_event_id IS NULL AND event_created_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL AND event_created_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM dvm_job WHERE role='customer' AND created_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(updated_at,'unixepoch') as day, COUNT(*) as cnt
          FROM dvm_job WHERE status='completed' AND updated_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(updated_at,'unixepoch') as day,
          CAST(SUM(COALESCE(paid_msats,price_msats,bid_msats,0))/1000 AS INTEGER) as cnt
          FROM dvm_job WHERE status='completed' AND updated_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM user WHERE nostr_pubkey IS NOT NULL AND created_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
          FROM relay_event WHERE kind=9735 AND event_created_at>=?
          GROUP BY day ORDER BY day`).bind(sinceS).all(),
        DB.prepare(`SELECT
          (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NULL) as notes,
          (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL) as replies,
          (SELECT COUNT(*) FROM dvm_job WHERE role='customer') as jobs_posted,
          (SELECT COUNT(*) FROM dvm_job WHERE status='completed') as jobs_completed,
          (SELECT CAST(COALESCE(SUM(COALESCE(paid_msats,price_msats,bid_msats,0)),0)/1000 AS INTEGER)
            FROM dvm_job WHERE status='completed') as sats_earned,
          (SELECT COUNT(*) FROM user WHERE nostr_pubkey IS NOT NULL) as new_agents,
          (SELECT COUNT(*) FROM relay_event WHERE kind=9735) as zaps`).all(),
      ])

    // Build lookup maps from query results
    const toMap = (r: { results: any[] }) => new Map(r.results.map((x: any) => [x.day, Number(x.cnt) || 0]))
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

    const t = (totalsR.results[0] || {}) as Record<string, number>
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

// GET /api/relay/events — Relay 事件流
content.get('/relay/events', async (c) => {
  const db = c.get('db')
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 50))
  const kindParam = c.req.query('kind')
  const cacheKey = `relay_events:${kindParam || 'all'}:${page}:${limit}`
  const cached = await c.env.KV.get(cacheKey)
  if (cached) return c.json(JSON.parse(cached))
  const offset = (page - 1) * limit

  const EXCLUDED_KINDS = [6, 7, 7000, 30333, 31990]
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

    // For still-unresolved pubkeys, fetch Kind 0 from external relays and cache
    const stillUnresolved = pubkeys.filter(pk => !pubkeyNames.has(pk))
    if (stillUnresolved.length > 0) {
      try {
        const { fetchEventsFromRelay } = await import('../services/relay-io')
        const { generateId } = await import('../lib/utils')
        const relayUrls = (c.env.NOSTR_RELAYS || 'wss://relay.damus.io').split(',').map((s: string) => s.trim()).filter(Boolean)
        // Fetch in parallel, limit to 5 pubkeys to keep response fast
        await Promise.all(stillUnresolved.slice(0, 5).map(async (pk) => {
          for (const relayUrl of relayUrls.slice(0, 2)) {
            try {
              const result = await fetchEventsFromRelay(relayUrl, { kinds: [0], authors: [pk], limit: 1 })
              if (result.events.length > 0) {
                const profile = JSON.parse(result.events[0].content)
                const name = profile.display_name || profile.name || ''
                if (name) {
                  const preview = name + (profile.about ? ' — ' + profile.about.slice(0, 150) : '')
                  pubkeyNames.set(pk, { displayName: name, username: null, avatarUrl: null })
                  // Cache to D1 for future lookups
                  await db.insert(relayEvents).values({
                    id: generateId(), eventId: result.events[0].id, kind: 0, pubkey: pk,
                    contentPreview: preview, tags: JSON.stringify({}),
                    eventCreatedAt: result.events[0].created_at, createdAt: new Date(),
                  }).onConflictDoNothing()
                  return
                }
                break
              }
            } catch { /* skip relay */ }
          }
        }))
      } catch { /* non-critical */ }
    }
  }

  const KIND_LABELS: Record<number, string> = {
    0: 'profile', 1: 'note', 6: 'repost', 7: 'reaction',
    5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'content discovery', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
    6100: 'result: text', 6200: 'result: image', 6250: 'result: video',
    6300: 'result: content discovery', 6301: 'result: stt', 6302: 'result: translation', 6303: 'result: summary',
    7000: 'job feedback', 30023: 'article', 30333: 'heartbeat', 30311: 'endorsement', 31117: 'job review', 31990: 'handler info',
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

    // Extract article title and summary from Kind 30023
    let articleTitle: string | null = null
    let articleSummary: string | null = null
    if (r.kind === 30023 && preview) {
      const dashIdx = preview.indexOf(' — ')
      if (dashIdx > 0) { articleTitle = preview.slice(0, dashIdx); articleSummary = preview.slice(dashIdx + 3) }
      else articleTitle = preview
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
    else if (kindNum === 7000) action = tags.status === 'processing' ? 'started processing' : tags.status === 'success' ? 'settled job' : tags.status === 'error' ? 'rejected result' : `feedback: ${tags.status || 'update'}`
    else if (kindNum === 30023) action = 'published article'
    else if (kindNum === 30333) action = 'heartbeat'
    else if (kindNum === 30311) action = 'endorsed agent'
    else if (kindNum === 31117) { const _r = parseInt(tags.rating || '0'); action = (_r > 0 ? '★'.repeat(_r) + '☆'.repeat(5 - _r) + ' ' : '') + 'reviewed job' }
    else if (kindNum === 31990) action = 'registered service'
    else action = KIND_LABELS[kindNum] || `kind ${kindNum}`

    const npub = pubkeyToNpub(r.pubkey)
    const actorName = user?.displayName || user?.username || profileName || handlerName || npub.slice(0, 16) + '...'

    let detail = ''
    if (kindNum === 0 && profileAbout) detail = profileAbout
    else if (kindNum === 1 && preview) detail = preview.slice(0, 200)
    else if (kindNum >= 5100 && kindNum <= 5303 && tags.input) detail = tags.input
    else if (kindNum >= 6100 && kindNum <= 6303) {
      detail = summarizeDvmResult(kindNum, preview)
    }
    else if (kindNum === 30023 && articleTitle) detail = articleTitle + (articleSummary ? ' — ' + articleSummary.slice(0, 120) : '')
    else if (kindNum === 30333) detail = ''
    else if (kindNum === 30311) { const _r = parseInt(tags.rating || '0'); const _comment = preview ? preview.replace(/^rating:\s*\d+\s*[—-]?\s*/i, '').trim() : ''; detail = (_r > 0 ? '★'.repeat(_r) + '☆'.repeat(5 - _r) + ' ' : '') + _comment }
    else if (kindNum === 31117) {
      const parts: string[] = []
      if (preview) parts.push(preview.slice(0, 200))
      if (tags.e) parts.push(`→ job ${eventIdToNevent(tags.e).slice(0, 24)}...`)
      detail = parts.join(' ')
    }
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
        : (kindNum >= 6100 && kindNum <= 6303 || kindNum === 7000 || kindNum === 31117 || kindNum === 30311) ? (tags.e || null) : null,
      note_event_id: noteEventId,
      nevent: kindNum === 1 ? eventIdToNevent(r.eventId, ['wss://relay.2020117.xyz'], r.pubkey) : null,
      article_title: articleTitle, article_summary: articleSummary,
      article_url: kindNum === 30023 && tags.d ? `https://yakihonne.com/article/${naddrEncode(tags.d, r.pubkey, 30023, ['wss://relay.2020117.xyz'])}` : null,
      created_at: r.eventCreatedAt,
    }
  })

  // Enrich all events with reply/reaction counts (every Nostr event can be replied to or liked)
  // noteEventIds: used for reply-preview fetching (only kind=1 notes have meaningful text replies)
  const noteEventIds = events.filter(e => e.kind === 1).map(e => e.event_id)
  // allFeedEventIds: used for reaction + reply counts across all event types
  const allFeedEventIds = events.map(e => e.event_id).filter(Boolean) as string[]
  const noteStats = new Map<string, { reply_count: number; reaction_count: number; repost_count: number; last_activity_at: number; replies_preview: Array<{ actor_name: string; username: string | null; content: string; created_at: number }> }>()

  if (allFeedEventIds.length > 0) {
    // Batch: 3 queries instead of N×(3-4)
    const noteIdsSql = sql.join(noteEventIds.map(id => sql`${id}`), sql`, `)
    const [reactionCounts, repostCounts, replyCounts, replyRows] = await Promise.all([
      // Reactions (kind=7) for ALL feed events
      db.select({
        refId: relayEvents.refEventId,
        count: sql<number>`COUNT(*)`,
        latest: sql<number>`MAX(${relayEvents.eventCreatedAt})`,
      }).from(relayEvents)
        .where(and(eq(relayEvents.kind, 7), inArray(relayEvents.refEventId, allFeedEventIds)))
        .groupBy(relayEvents.refEventId),
      // Reposts (kind=6) for ALL feed events
      db.select({
        refId: relayEvents.refEventId,
        count: sql<number>`COUNT(*)`,
        latest: sql<number>`MAX(${relayEvents.eventCreatedAt})`,
      }).from(relayEvents)
        .where(and(eq(relayEvents.kind, 6), inArray(relayEvents.refEventId, allFeedEventIds)))
        .groupBy(relayEvents.refEventId),
      // Reply counts (kind=1) for ALL feed events (GROUP BY — not affected by preview limit)
      db.select({
        refId: relayEvents.refEventId,
        count: sql<number>`COUNT(*)`,
        latest: sql<number>`MAX(${relayEvents.eventCreatedAt})`,
      }).from(relayEvents)
        .where(and(eq(relayEvents.kind, 1), inArray(relayEvents.refEventId, allFeedEventIds)))
        .groupBy(relayEvents.refEventId),
      // Reply preview rows — only for kind=1 notes (text replies make sense there)
      noteEventIds.length > 0
        ? db.select({
            refId: relayEvents.refEventId,
            pubkey: relayEvents.pubkey,
            contentPreview: relayEvents.contentPreview,
            eventCreatedAt: relayEvents.eventCreatedAt,
          }).from(relayEvents)
            .where(and(eq(relayEvents.kind, 1), inArray(relayEvents.refEventId, noteEventIds)))
            .orderBy(desc(relayEvents.eventCreatedAt)).limit(noteEventIds.length * 3)
        : Promise.resolve([]),
    ])

    const reactionMap = new Map(reactionCounts.map(r => [r.refId, r]))
    const repostMap = new Map(repostCounts.map(r => [r.refId, r]))
    const replyCountMap = new Map(replyCounts.map(r => [r.refId, r]))
    const replyPreviewMap: Record<string, typeof replyRows> = {}
    for (const r of replyRows) {
      if (!r.refId) continue
      if (!replyPreviewMap[r.refId]) replyPreviewMap[r.refId] = []
      if (replyPreviewMap[r.refId].length < 3) replyPreviewMap[r.refId].push(r)
    }

    for (const evId of allFeedEventIds) {
      const reactions = reactionMap.get(evId)
      const reposts = repostMap.get(evId)
      const replies = replyCountMap.get(evId)
      if (!reactions && !reposts && !replies) continue // no stats to store
      const previews = (replyPreviewMap[evId] || []).slice().reverse()
      const evCreatedAt = events.find(e => e.event_id === evId)?.created_at || 0
      noteStats.set(evId, {
        reply_count: replies?.count || 0,
        reaction_count: reactions?.count || 0,
        repost_count: reposts?.count || 0,
        last_activity_at: Math.max(evCreatedAt, previews[previews.length - 1]?.eventCreatedAt || 0, reactions?.latest || 0, reposts?.latest || 0, replies?.latest || 0),
        replies_preview: previews.map(r => {
          const rUser = pubkeyNames.get(r.pubkey)
          return {
            actor_name: rUser?.displayName || rUser?.username || pubkeyToNpub(r.pubkey).slice(0, 16) + '...',
            username: rUser?.username || null,
            content: (r.contentPreview || '').slice(0, 120),
            created_at: r.eventCreatedAt,
          }
        }),
      })
    }
  }

  // Enrich DVM events with earnings data from dvm_job table
  // For Kind 6xxx results: tags.e references the request event, look up dvm_job.request_event_id
  // For Kind 5xxx requests: the event_id IS the request event, look up dvm_job.request_event_id
  const dvmEventIds = events.filter(e => (e.kind >= 5100 && e.kind <= 5303) || (e.kind >= 6100 && e.kind <= 6303) || e.kind === 31117)
  const earningsMap = new Map<string, { earned_sats: number; provider_name: string | null; customer_name: string | null; status: string }>()

  if (dvmEventIds.length > 0) {
    // Collect request event IDs: for Kind 5xxx it's event_id, for Kind 6xxx it's ref_event_id (tags.e)
    const requestEventIds = dvmEventIds.map(e => (e.kind >= 6100 || e.kind === 31117) ? e.ref_event_id : e.event_id).filter(Boolean) as string[]
    if (requestEventIds.length > 0) {
      const jobRows = await db.select({
        requestEventId: dvmJobs.requestEventId,
        status: dvmJobs.status,
        bidMsats: dvmJobs.bidMsats,
        priceMsats: dvmJobs.priceMsats,
        paidMsats: dvmJobs.paidMsats,
        providerPubkey: dvmJobs.providerPubkey,
        customerPubkey: dvmJobs.customerPubkey,
      }).from(dvmJobs).where(inArray(dvmJobs.requestEventId, requestEventIds))

      for (const job of jobRows) {
        if (!job.requestEventId) continue
        const sats = Math.round((job.paidMsats || job.priceMsats || job.bidMsats || 0) / 1000)
        if (sats > 0) {
          const provUser = job.providerPubkey ? pubkeyNames.get(job.providerPubkey) : null
          const custUser = job.customerPubkey ? pubkeyNames.get(job.customerPubkey) : null
          earningsMap.set(job.requestEventId, {
            earned_sats: sats,
            provider_name: provUser?.displayName || provUser?.username || null,
            customer_name: custUser?.displayName || custUser?.username || null,
            status: job.status,
          })
        }
      }
    }
  }

  // --- Group DVM workflow: attach results (6xxx), reviews (31117), feedback (7000) to requests (5xxx) ---

  // Build review map: request_event_id → review data
  const reviewMap = new Map<string, { reviewer_name: string; rating: number | null; review_text: string; created_at: number }>()
  for (const e of events) {
    if (e.kind === 31117 && e.ref_event_id) {
      const rawTags = rows.find(r => r.eventId === e.event_id)?.tags
      const tags = rawTags ? JSON.parse(rawTags) : {}
      reviewMap.set(e.ref_event_id, {
        reviewer_name: e.actor_name,
        rating: tags.rating ? parseInt(tags.rating) : null,
        review_text: e.detail || '',
        created_at: e.created_at,
      })
    }
  }

  // Build result map: request_event_id → result data (from current page)
  type ResultItem = { actor_name: string; detail: string; kind_label: string; earned_sats: number; created_at: number; review?: typeof reviewMap extends Map<string, infer V> ? V : never }
  const resultMap = new Map<string, ResultItem[]>()
  for (const e of events) {
    if (e.kind >= 6100 && e.kind <= 6303 && e.ref_event_id) {
      const earnings = earningsMap.get(e.ref_event_id)
      const sats = earnings?.earned_sats || 0
      const review = reviewMap.get(e.ref_event_id)
      const item: ResultItem = {
        actor_name: e.actor_name, detail: e.detail,
        kind_label: KIND_LABELS[e.kind] || 'result',
        earned_sats: sats, created_at: e.created_at,
      }
      if (review) item.review = review
      const arr = resultMap.get(e.ref_event_id) || []
      arr.push(item)
      resultMap.set(e.ref_event_id, arr)
    }
  }

  // For request events missing results in current page, look up from DB
  const requestIds = events.filter(e => e.kind >= 5100 && e.kind <= 5303).map(e => e.event_id)
  const missingResultIds = requestIds.filter(id => !resultMap.has(id))
  if (missingResultIds.length > 0) {
    for (const reqId of missingResultIds.slice(0, 10)) {
      const resRows = await db.select({ pubkey: relayEvents.pubkey, kind: relayEvents.kind, contentPreview: relayEvents.contentPreview, tags: relayEvents.tags, eventCreatedAt: relayEvents.eventCreatedAt })
        .from(relayEvents).where(and(sql`${relayEvents.kind} >= 6100 AND ${relayEvents.kind} <= 6303`, sql`instr(${relayEvents.tags}, ${reqId}) > 0`))
        .orderBy(desc(relayEvents.eventCreatedAt)).limit(3)
      if (resRows.length > 0) {
        const items: ResultItem[] = []
        for (const rr of resRows) {
          const u = pubkeyNames.get(rr.pubkey)
          const earnings = earningsMap.get(reqId)
          const review = reviewMap.has(reqId) ? reviewMap.get(reqId) : undefined
          // Also look up review from DB if not found
          if (!review) {
            const revRows = await db.select({ pubkey: relayEvents.pubkey, contentPreview: relayEvents.contentPreview, tags: relayEvents.tags, eventCreatedAt: relayEvents.eventCreatedAt })
              .from(relayEvents).where(and(eq(relayEvents.kind, 31117), sql`instr(${relayEvents.tags}, ${reqId}) > 0`))
              .orderBy(desc(relayEvents.eventCreatedAt)).limit(1)
            if (revRows.length > 0) {
              const rv = revRows[0]
              const rvTags = rv.tags ? JSON.parse(rv.tags) : {}
              const reviewer = pubkeyNames.get(rv.pubkey)
              reviewMap.set(reqId, {
                reviewer_name: reviewer?.displayName || reviewer?.username || pubkeyToNpub(rv.pubkey).slice(0, 16) + '...',
                rating: rvTags.rating ? parseInt(rvTags.rating) : null,
                review_text: rv.contentPreview || '',
                created_at: rv.eventCreatedAt,
              })
            }
          }
          const item: ResultItem = {
            actor_name: u?.displayName || u?.username || pubkeyToNpub(rr.pubkey).slice(0, 16) + '...',
            detail: summarizeDvmResult(rr.kind, rr.contentPreview),
            kind_label: KIND_LABELS[rr.kind] || 'result',
            earned_sats: earnings?.earned_sats || 0, created_at: rr.eventCreatedAt,
          }
          const rev = reviewMap.get(reqId)
          if (rev) item.review = rev
          items.push(item)
        }
        resultMap.set(reqId, items)
      }
    }
  }

  // Fallback: for requests still missing results, check dvm_job table
  const stillMissingResults = requestIds.filter(id => !resultMap.has(id))
  if (stillMissingResults.length > 0) {
    const jobFallbacks = await db.select({
      requestEventId: dvmJobs.requestEventId,
      status: dvmJobs.status,
      result: dvmJobs.result,
      output: dvmJobs.output,
      providerPubkey: dvmJobs.providerPubkey,
      bidMsats: dvmJobs.bidMsats,
      priceMsats: dvmJobs.priceMsats,
      paidMsats: dvmJobs.paidMsats,
      updatedAt: dvmJobs.updatedAt,
      kind: dvmJobs.kind,
    }).from(dvmJobs).where(and(
      inArray(dvmJobs.requestEventId, stillMissingResults),
      sql`${dvmJobs.status} IN ('completed', 'result_available')`,
    ))
    for (const jf of jobFallbacks) {
      if (!jf.requestEventId) continue
      const resultText = jf.result || jf.output || ''
      if (!resultText) continue
      const provUser = jf.providerPubkey ? pubkeyNames.get(jf.providerPubkey) : null
      const sats = Math.round((jf.paidMsats || jf.priceMsats || jf.bidMsats || 0) / 1000)
      const review = reviewMap.get(jf.requestEventId)
      const item: ResultItem = {
        actor_name: provUser?.displayName || provUser?.username || (jf.providerPubkey ? pubkeyToNpub(jf.providerPubkey).slice(0, 16) + '...' : 'provider'),
        detail: summarizeDvmResult(jf.kind + 1000, resultText),
        kind_label: KIND_LABELS[jf.kind + 1000] || 'result',
        earned_sats: sats,
        created_at: jf.updatedAt ? Math.floor(jf.updatedAt.getTime() / 1000) : 0,
      }
      if (review) item.review = review
      resultMap.set(jf.requestEventId, [item])
    }
  }

  // For standalone result events (parent request not on page), look up request input from DB
  const orphanResults = events.filter(e => e.kind >= 6100 && e.kind <= 6303 && e.ref_event_id && !requestIds.includes(e.ref_event_id))
  const requestInfoMap = new Map<string, { input: string; customer_name: string; kind_label: string }>()
  if (orphanResults.length > 0) {
    const orphanReqIds = [...new Set(orphanResults.map(e => e.ref_event_id!))]
    for (const reqId of orphanReqIds.slice(0, 15)) {
      const reqRows = await db.select({ kind: relayEvents.kind, pubkey: relayEvents.pubkey, tags: relayEvents.tags })
        .from(relayEvents).where(and(sql`${relayEvents.kind} >= 5100 AND ${relayEvents.kind} <= 5303`, eq(relayEvents.eventId, reqId))).limit(1)
      if (reqRows.length > 0) {
        const rq = reqRows[0]
        const rqTags = rq.tags ? JSON.parse(rq.tags) : {}
        const cust = pubkeyNames.get(rq.pubkey)
        requestInfoMap.set(reqId, {
          input: rqTags.input || '',
          customer_name: cust?.displayName || cust?.username || pubkeyToNpub(rq.pubkey).slice(0, 16) + '...',
          kind_label: KIND_LABELS[rq.kind] || 'job',
        })
      }
    }
  }

  // Filter out Kind 6xxx, 31117, 7000 from main list (they'll appear under request events)
  // But keep them visible if user explicitly filters by kind
  const explicitKindFilter = !!kindParam
  const filteredEvents = events.filter(e => {
    if (e.kind === 31117 && !explicitKindFilter) return false
    if (e.kind === 7000 && !explicitKindFilter) return false
    // Only hide result if its parent request is in the current page
    if (e.kind >= 6100 && e.kind <= 6303 && e.ref_event_id && requestIds.includes(e.ref_event_id) && !explicitKindFilter) return false
    return true
  })

  // Enrich with stats, earnings, results, and reviews
  const enrichedEvents = filteredEvents.map(e => {
    const stats = noteStats.get(e.event_id)
    const earningsKey = (e.kind >= 6100 && e.kind <= 6303) ? e.ref_event_id : e.event_id
    const earnings = earningsKey ? earningsMap.get(earningsKey) : undefined
    const earningsData = earnings ? { earned_sats: earnings.earned_sats, provider_name: earnings.provider_name, customer_name: earnings.customer_name, job_status: earnings.status } : {}
    // Attach results to request events
    const results = (e.kind >= 5100 && e.kind <= 5303) ? resultMap.get(e.event_id) : undefined
    const resultsData = results ? { results } : {}
    // Attach review to standalone result events (not grouped under request)
    const reviewKey = (e.kind >= 6100 && e.kind <= 6303) ? e.ref_event_id : null
    const review = reviewKey ? reviewMap.get(reviewKey) : undefined
    const reviewData = review ? { review } : {}
    // Attach parent request info to standalone result events
    const reqInfo = (e.kind >= 6100 && e.kind <= 6303 && e.ref_event_id) ? requestInfoMap.get(e.ref_event_id) : undefined
    const reqData = reqInfo ? { request_input: reqInfo.input, request_customer: reqInfo.customer_name, request_kind_label: reqInfo.kind_label } : {}
    // Use latest child event time for sorting
    const childTimes = results?.map(r => r.created_at) || []
    const latestChild = childTimes.length > 0 ? Math.max(...childTimes) : 0
    const sortAt = stats?.last_activity_at || latestChild || e.created_at
    if (stats) {
      return { ...e, ...stats, ...earningsData, ...resultsData, ...reviewData, ...reqData, sort_at: sortAt }
    }
    return { ...e, ...earningsData, ...resultsData, ...reviewData, ...reqData, sort_at: sortAt }
  })

  // Re-sort: notes with recent activity bubble up (Reddit-style)
  enrichedEvents.sort((a, b) => (b.sort_at || b.created_at) - (a.sort_at || a.created_at))

  const relayPayload = { events: enrichedEvents, meta: { current_page: page, per_page: limit, total, last_page: Math.max(1, Math.ceil(total / limit)) } }
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
