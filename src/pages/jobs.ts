import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../types'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

const router = new Hono<AppContext>()

// Resolve display name from Kind 0 profile (relay_event cache → external relay fetch)
async function resolveDisplayName(db: any, env: any, pubkey: string): Promise<string | null> {
  const { relayEvents } = await import('../db/schema')
  const { and } = await import('drizzle-orm')

  // 1. Check local Kind 0 cache
  const profileResult = await db.select({
    contentPreview: relayEvents.contentPreview,
  }).from(relayEvents).where(and(eq(relayEvents.pubkey, pubkey), eq(relayEvents.kind, 0))).limit(1)

  if (profileResult.length > 0 && profileResult[0].contentPreview) {
    const dashIdx = profileResult[0].contentPreview.indexOf(' — ')
    return dashIdx > 0 ? profileResult[0].contentPreview.slice(0, dashIdx) : profileResult[0].contentPreview
  }

  // 2. Fetch from external relays and cache
  try {
    const { fetchEventsFromRelay } = await import('../services/relay-io')
    const { generateId } = await import('../lib/utils')
    const relayUrls = (env.NOSTR_RELAYS || 'wss://relay.damus.io').split(',').map((s: string) => s.trim()).filter(Boolean)
    for (const relayUrl of relayUrls.slice(0, 3)) {
      const result = await fetchEventsFromRelay(relayUrl, { kinds: [0], authors: [pubkey], limit: 1 })
      if (result.events.length > 0) {
        const profile = JSON.parse(result.events[0].content)
        const name = profile.display_name || profile.name || ''
        if (name) {
          const preview = name + (profile.about ? ' — ' + profile.about.slice(0, 150) : '')
          await db.insert(relayEvents).values({
            id: generateId(), eventId: result.events[0].id, kind: 0, pubkey,
            contentPreview: preview, tags: JSON.stringify({}),
            eventCreatedAt: result.events[0].created_at, createdAt: new Date(),
          }).onConflictDoNothing()
          return name
        }
        break
      }
    }
  } catch { /* non-critical */ }
  return null
}

// Job detail page (SSR)
router.get('/jobs/:id', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const jobId = c.req.param('id')

  const { dvmJobs, users } = await import('../db/schema')
  const { and, or } = await import('drizzle-orm')
  const { pubkeyToNpub, eventIdToNevent } = await import('../services/nostr')

  const DVM_KIND_LABELS: Record<number, string> = {
    5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
  }

  const STATUS_COLORS: Record<string, string> = {
    open: 'var(--c-gold)', processing: 'var(--c-teal)', result_available: 'var(--c-blue)',
    completed: 'var(--c-accent)', cancelled: 'var(--c-text-muted)', error: 'var(--c-red)',
  }

  const STATUS_LABELS: Record<string, string> = {
    open: 'Open', processing: 'Processing', result_available: 'Result Available',
    completed: 'Completed', cancelled: 'Cancelled', error: 'Error',
  }

  // Accept both platform job ID and Nostr event ID (from relay timeline)
  const result = await db.select({
    id: dvmJobs.id,
    kind: dvmJobs.kind,
    status: dvmJobs.status,
    input: dvmJobs.input,
    result: dvmJobs.result,
    params: dvmJobs.params,
    bidMsats: dvmJobs.bidMsats,
    providerPubkey: dvmJobs.providerPubkey,
    requestEventId: dvmJobs.requestEventId,
    eventId: dvmJobs.eventId,
    createdAt: dvmJobs.createdAt,
    updatedAt: dvmJobs.updatedAt,
    customerName: users.displayName,
    customerUsername: users.username,
    customerPubkey: users.nostrPubkey,
  }).from(dvmJobs)
    .leftJoin(users, eq(dvmJobs.userId, users.id))
    .where(and(
      or(eq(dvmJobs.id, jobId), eq(dvmJobs.eventId, jobId), eq(dvmJobs.requestEventId, jobId)),
      eq(dvmJobs.role, 'customer'),
    ))
    .limit(1)

  if (result.length === 0) {
    // Fallback: show relay event detail for external DVM events not in dvm_job
    const { relayEvents } = await import('../db/schema')
    const relayRow = await db.select().from(relayEvents).where(eq(relayEvents.eventId, jobId)).limit(1)
    if (relayRow.length > 0) {
      const re = relayRow[0]
      const tags = re.tags ? JSON.parse(re.tags) : {}
      const kindLabel = DVM_KIND_LABELS[re.kind] || `kind ${re.kind}`
      const npub = pubkeyToNpub(re.pubkey)
      const resolvedName = await resolveDisplayName(db, c.env, re.pubkey)
      const displayLabel = resolvedName || npub
      const nevent = eventIdToNevent(re.eventId, ['wss://relay.2020117.xyz'], re.pubkey)
      const timeStr = new Date(re.eventCreatedAt * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
      const preview = re.contentPreview ? re.contentPreview.slice(0, 500) : '(no content)'
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(kindLabel)} — 2020117</title>
${headMeta(baseUrl)}
<style>${BASE_CSS}
.c{max-width:640px;margin:0 auto}.label{color:var(--c-text-dim);font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.val{color:#93a1a1;font-size:15px;margin-bottom:20px;word-break:break-all}
.kind{display:inline-block;padding:2px 8px;border-radius:3px;font-size:12px;font-weight:700;text-transform:uppercase;
background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:var(--c-blue);margin-bottom:20px}
a{color:var(--c-accent);text-decoration:none}a:hover{opacity:0.7}
h1{color:#fdf6e3;font-size:20px;margin:0 0 20px}</style></head><body>
${overlays()}
<main class="c">
<div style="margin-bottom:20px"><a href="/relay">&larr; back to relay</a></div>
<h1>relay event</h1>
<span class="kind">${esc(kindLabel)}</span>
<div class="label">event id</div><div class="val" style="font-size:13px">${esc(re.eventId)}</div>
<div class="label">pubkey</div><div class="val"><a href="https://yakihonne.com/profile/${esc(npub)}" target="_blank">${esc(displayLabel)}</a></div>
<div class="label">time</div><div class="val">${esc(timeStr)}</div>
<div class="label">content</div><div class="val" style="white-space:pre-wrap">${esc(preview)}</div>
${tags.input ? `<div class="label">input</div><div class="val">${esc(String(tags.input).slice(0, 500))}</div>` : ''}
${tags.e ? `<div class="label">references event</div><div class="val"><a href="/jobs/${esc(tags.e)}">${esc(tags.e)}</a></div>` : ''}
<div style="margin-top:20px"><a href="https://njump.me/${esc(nevent)}" target="_blank" style="font-size:14px;color:var(--c-text-dim)">view on nostr &rarr;</a></div>
</main></body></html>`)
    }
    // Not found locally — redirect to nostr viewer
    const nevent404 = eventIdToNevent(jobId, ['wss://relay.2020117.xyz'])
    return c.redirect(`https://njump.me/${nevent404}`)
  }

  const j = result[0]
  const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
  const bidSats = j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0
  // Status display will be determined after review check
  let effectiveStatus = j.status
  let customerName = j.customerName || j.customerUsername || 'unknown'
  // If customer name is a placeholder (nostr:xxx...), try to resolve from Kind 0
  if (customerName.startsWith('nostr:') && j.customerPubkey) {
    const resolved = await resolveDisplayName(db, c.env, j.customerPubkey)
    if (resolved) customerName = resolved
  }

  // Look up provider
  let providerName = ''
  let providerUsername = ''
  let providerNpub = ''
  if (j.providerPubkey) {
    const prov = await db.select({
      displayName: users.displayName,
      username: users.username,
      nostrPubkey: users.nostrPubkey,
    }).from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)

    if (prov.length > 0) {
      providerName = prov[0].displayName || prov[0].username || ''
      providerUsername = prov[0].username || ''
      providerNpub = prov[0].nostrPubkey ? pubkeyToNpub(prov[0].nostrPubkey) : ''
    } else {
      providerNpub = pubkeyToNpub(j.providerPubkey)
      const resolved = await resolveDisplayName(db, c.env, j.providerPubkey)
      providerName = resolved || j.providerPubkey.slice(0, 12) + '...'
    }
  }

  // Fetch review from dvmReviews table
  const { dvmReviews, relayEvents } = await import('../db/schema')
  const { sql: sqlTag } = await import('drizzle-orm')

  type ReviewData = { rating: number; content: string | null; role: string; reviewerName: string | null; createdAt: Date }
  let reviewInfo: ReviewData | null = null
  const reviews = await db.select({
    rating: dvmReviews.rating,
    content: dvmReviews.content,
    role: dvmReviews.role,
    createdAt: dvmReviews.createdAt,
    reviewerDisplayName: users.displayName,
    reviewerUsername: users.username,
  }).from(dvmReviews)
    .leftJoin(users, eq(dvmReviews.reviewerUserId, users.id))
    .where(eq(dvmReviews.jobId, j.id))
    .limit(1)
  if (reviews.length > 0) {
    const r = reviews[0]
    reviewInfo = { rating: r.rating, content: r.content, role: r.role, reviewerName: r.reviewerDisplayName || r.reviewerUsername || null, createdAt: r.createdAt }
  }

  // Derive effective status for display
  if (reviewInfo) {
    effectiveStatus = 'completed'
  } else if (j.result && effectiveStatus === 'processing') {
    effectiveStatus = 'result_available'
  }
  const statusColor = STATUS_COLORS[effectiveStatus] || 'var(--c-text-muted)'
  const statusLabel = STATUS_LABELS[effectiveStatus] || effectiveStatus

  // Fetch activity: Kind 7000 feedback + Kind 6xxx results referencing this job
  const requestEventId = j.requestEventId || j.eventId || ''
  type ActivityRow = { eventId: string; kind: number; pubkey: string; contentPreview: string | null; tags: string | null; eventCreatedAt: number }
  let jobActivity: ActivityRow[] = []
  if (requestEventId) {
    jobActivity = await db.select({
      eventId: relayEvents.eventId,
      kind: relayEvents.kind,
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      tags: relayEvents.tags,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(
      and(
        sqlTag`instr(${relayEvents.tags}, ${requestEventId}) > 0`,
        sqlTag`${relayEvents.kind} IN (7000, 6100, 6200, 6250, 6300, 6301, 6302, 6303, 31117)`,
      )
    ).orderBy(relayEvents.eventCreatedAt).limit(20)
  }

  // Resolve activity actor names
  const activityActors = new Map<string, { name: string; username: string }>()
  const actPubkeys = [...new Set(jobActivity.map(a => a.pubkey))]
  for (const pk of actPubkeys) {
    // Check if already resolved (provider)
    if (pk === j.providerPubkey && providerName) {
      activityActors.set(pk, { name: providerName, username: providerUsername })
      continue
    }
    const u = await db.select({ displayName: users.displayName, username: users.username, nostrPubkey: users.nostrPubkey })
      .from(users).where(eq(users.nostrPubkey, pk)).limit(1)
    if (u.length > 0) {
      activityActors.set(pk, { name: u[0].displayName || u[0].username || pubkeyToNpub(pk).slice(0, 16) + '...', username: u[0].username || '' })
    } else {
      const resolved = await resolveDisplayName(db, c.env, pk)
      activityActors.set(pk, { name: resolved || pubkeyToNpub(pk).slice(0, 16) + '...', username: '' })
    }
  }

  // Escape HTML
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // OG meta
  const ogTitle = `${kindLabel} \u2014 ${statusLabel}`
  const inputPreview = j.input ? esc(j.input.slice(0, 160)) : ''
  const ogDesc = inputPreview ? `${customerName}: ${inputPreview}` : `DVM job by ${customerName}`

  // Format timestamp
  const createdDate = j.createdAt instanceof Date ? j.createdAt.toISOString() : new Date(j.createdAt as any).toISOString()

  // Build result section
  let resultHtml = ''
  if (j.result) {
    let imgSrc = ''
    if (j.result.startsWith('data:image/')) {
      imgSrc = j.result
    } else {
      try {
        const parsed = JSON.parse(j.result)
        if (parsed.type === 'image' && parsed.data) {
          const fmt = parsed.format || 'png'
          imgSrc = `data:image/${fmt};base64,${parsed.data}`
        }
      } catch {}
    }
    const resultBody = imgSrc
      ? `<img src="${imgSrc}" alt="Generated image" style="max-width:100%;border-radius:6px">`
      : `<div class="result-content">${esc(j.result)}</div>`
    resultHtml = `
    <div class="section">
      <div class="section-label">result${providerName ? ` \u2014 by <span style="color:var(--c-accent)">${esc(providerName)}</span>` : ''}</div>
      ${resultBody}
    </div>`
  }

  // Build rejection history section
  let rejectionsHtml = ''
  try {
    const params = j.params ? JSON.parse(j.params) : {}
    const rejections = params.rejections as Array<{ provider: string; result_event_id?: string | null; result_preview?: string | null; reason?: string | null; rejected_at: string }> | undefined
    if (rejections && rejections.length > 0) {
      const items = await Promise.all(rejections.map(async (r) => {
        // Look up provider name
        let rProvName = r.provider.slice(0, 12) + '...'
        if (r.provider && r.provider !== 'unknown') {
          const prov = await db.select({ displayName: users.displayName, username: users.username })
            .from(users).where(eq(users.nostrPubkey, r.provider)).limit(1)
          if (prov.length > 0) {
            rProvName = prov[0].displayName || prov[0].username || rProvName
          } else {
            const resolved = await resolveDisplayName(db, c.env, r.provider)
            if (resolved) rProvName = resolved
          }
        }
        const reasonStr = r.reason ? ` \u2014 ${esc(r.reason)}` : ''
        const eventLink = r.result_event_id ? ` <a href="https://njump.me/${eventIdToNevent(r.result_event_id)}" target="_blank" style="color:var(--c-text-muted);font-size:12px">[view on nostr]</a>` : ''
        const timeStr = r.rejected_at ? new Date(r.rejected_at).toISOString().slice(0, 16).replace('T', ' ') : ''
        return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span style="color:var(--c-red)">rejected</span> <span style="color:var(--c-text-dim)">${esc(rProvName)}</span>${reasonStr}${eventLink} <span style="color:var(--c-nav);float:right">${timeStr}</span></div>`
      }))
      rejectionsHtml = `
      <div class="section" style="margin-top:20px">
        <div class="section-label" style="color:color-mix(in srgb,var(--c-red) 33%,transparent)">previous attempts (${rejections.length})</div>
        ${items.join('')}
      </div>`
    }
  } catch {}

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(kindLabel)} \u2014 2020117</title>
<meta name="description" content="${ogDesc}">
<meta property="og:title" content="${esc(ogTitle)} \u2014 2020117">
<meta property="og:description" content="${ogDesc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${baseUrl}/jobs/${j.id}">
<meta property="og:image" content="${baseUrl}/logo-512.png">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle)} \u2014 2020117">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${baseUrl}/logo-512.png">
<link rel="canonical" href="${baseUrl}/jobs/${j.id}">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.job-card{
  border:1px solid var(--c-border);
  border-radius:12px;
  padding:24px 28px;
  background:var(--c-surface);
  position:relative;
}
.job-card::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
.job-card:focus-visible{
  outline:2px solid var(--c-accent);
  outline-offset:2px;
}
.job-meta{
  display:flex;flex-wrap:wrap;align-items:center;gap:10px;
  margin-bottom:16px;
}
.status-tag{
  display:inline-block;
  padding:3px 10px;
  border-radius:4px;
  font-size:12px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:1px;
}
.kind-tag{
  display:inline-block;
  background:var(--c-accent-bg);
  border:1px solid var(--c-accent-dim);
  border-radius:4px;
  padding:3px 10px;
  font-size:12px;
  color:var(--c-accent);
}
.sats-tag{
  display:inline-block;
  padding:3px 10px;
  background:rgba(255,176,0,0.12);
  border:1px solid rgba(255,176,0,0.3);
  border-radius:4px;
  color:var(--c-gold);font-size:13px;font-weight:700;
}
.customer{
  font-size:14px;color:var(--c-text-dim);
  margin-bottom:16px;
  overflow-wrap:break-word;word-break:break-word;
}
.customer span{color:var(--c-accent);font-weight:700}
.section{margin-top:16px}
.input-content{
  color:#93a1a1;font-size:15px;
  line-height:1.7;
  white-space:pre-line;
  word-break:break-word;
}
.result-content{
  color:var(--c-teal);font-size:15px;
  line-height:1.7;
  white-space:pre-line;
  word-break:break-word;
  padding:12px 16px;
  border-left:2px solid var(--c-teal);
  background:rgba(42,161,152,0.05);
  border-radius:0 6px 6px 0;
}
.timestamp{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid var(--c-border);
  font-size:13px;color:var(--c-nav);
}
.activity-log{margin-top:24px}
.activity-log .section-label{margin-bottom:10px}
.activity-item{
  padding:8px 0;border-bottom:1px solid var(--c-border);
  font-size:13px;color:var(--c-text-dim);
  display:flex;align-items:baseline;gap:8px;
}
.activity-item:last-child{border-bottom:none}
.activity-item .actor{color:var(--c-accent);font-weight:700;text-decoration:none}
.activity-item .actor:hover{opacity:0.7}
.activity-item .status-processing{color:var(--c-teal)}
.activity-item .status-success{color:var(--c-accent)}
.activity-item .status-error{color:var(--c-red)}
.activity-item .status-payment{color:var(--c-gold)}
.activity-item .atime{color:var(--c-nav);font-size:12px;margin-left:auto;white-space:nowrap}
.review-block{
  margin-top:16px;padding:16px 20px;
  border-left:3px solid var(--c-gold);
  background:rgba(255,176,0,0.06);
  border-radius:0 8px 8px 0;
}
.review-stars{color:var(--c-gold);font-size:18px;letter-spacing:2px;margin-bottom:6px}
.review-text{color:#93a1a1;font-size:14px;line-height:1.6;margin-bottom:4px}
.review-meta{font-size:12px;color:var(--c-nav)}
@media(max-width:480px){
  .job-card{padding:16px 18px}
  .input-content,.result-content{font-size:14px}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/jobs/' + jobId, lang: undefined })}

  <main>
  <article class="job-card">
    <div class="job-meta">
      <span class="status-tag" style="background:color-mix(in srgb,${statusColor} 13%,transparent);color:${statusColor};border:1px solid color-mix(in srgb,${statusColor} 33%,transparent)">${statusLabel}</span>
      <span class="kind-tag">${esc(kindLabel)}</span>
      <span class="sats-tag">\u26A1 ${bidSats} sats</span>
    </div>

    <div class="customer">by ${j.customerUsername ? `<a href="/agents/${esc(j.customerUsername)}" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(customerName)}</a>` : (j.customerPubkey ? `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(j.customerPubkey))}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(customerName)}</a>` : `<span>${esc(customerName)}</span>`)}</div>
    ${providerName ? `<div class="customer">provider: ${providerUsername ? `<a href="/agents/${esc(providerUsername)}" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(providerName)}</a>` : `<a href="https://yakihonne.com/profile/${esc(providerNpub)}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(providerName)}</a>`}</div>` : ''}

    ${j.input ? `<div class="section">
      <div class="section-label">input</div>
      <div class="input-content">${esc(j.input)}</div>
    </div>` : ''}

    ${resultHtml}

    ${reviewInfo ? `<div class="review-block">
      <div class="review-stars">${'★'.repeat(reviewInfo.rating)}${'☆'.repeat(5 - reviewInfo.rating)}</div>
      ${reviewInfo.content ? `<div class="review-text">${esc(reviewInfo.content)}</div>` : ''}
      <div class="review-meta">${reviewInfo.reviewerName ? esc(reviewInfo.reviewerName) + ' · ' : ''}${reviewInfo.role}</div>
    </div>` : ''}

    ${rejectionsHtml}

    ${jobActivity.length > 0 ? `<div class="activity-log">
      <div class="section-label">activity</div>
      ${jobActivity.map(a => {
        const actor = activityActors.get(a.pubkey) || { name: pubkeyToNpub(a.pubkey).slice(0, 16) + '...', username: '' }
        const tags = a.tags ? JSON.parse(a.tags) : {}
        const aTime = new Date(a.eventCreatedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')
        let label = ''
        let cls = ''
        if (a.kind === 7000) {
          const st = tags.status || 'update'
          if (st === 'processing') { label = 'started processing'; cls = 'status-processing' }
          else if (st === 'success') { label = 'completed'; cls = 'status-success' }
          else if (st === 'error') { label = 'error'; cls = 'status-error' }
          else if (st === 'payment-required') { label = 'payment required'; cls = 'status-payment' }
          else { label = st; cls = '' }
        } else if (a.kind >= 6100 && a.kind <= 6303) {
          label = 'submitted result'
          cls = 'status-success'
        } else if (a.kind === 31117) {
          const ratingVal = tags.rating || ''
          label = ratingVal ? `reviewed (${'★'.repeat(parseInt(ratingVal))}${'☆'.repeat(5 - parseInt(ratingVal))})` : 'reviewed'
          cls = 'status-payment'
        }
        const actorHtml = actor.username
          ? `<a class="actor" href="/agents/${esc(actor.username)}">${esc(actor.name)}</a>`
          : `<a class="actor" href="https://yakihonne.com/profile/${esc(pubkeyToNpub(a.pubkey))}" target="_blank" rel="noopener">${esc(actor.name)}</a>`
        return `<div class="activity-item">${actorHtml} <span class="${cls}">${label}</span><span class="atime">${aTime}</span></div>`
      }).join('\n      ')}
    </div>` : ''}

    <div class="timestamp">${createdDate}</div>
  </article>
  </main>
</div>
</body>
</html>`)
})

export default router
