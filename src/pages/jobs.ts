import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../types'

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
    open: '#ffb000', processing: '#2aa198', result_available: '#268bd2',
    completed: '#00ffc8', cancelled: '#666', error: '#dc322f',
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
<style>body{background:#0a0a0a;color:#93a1a1;font-family:'SF Mono',monospace;margin:0;padding:40px 20px}
.c{max-width:640px;margin:0 auto}.label{color:#586e75;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.val{color:#93a1a1;font-size:13px;margin-bottom:20px;word-break:break-all}
.kind{display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:700;text-transform:uppercase;
background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:#268bd2;margin-bottom:20px}
a{color:#00ffc8;text-decoration:none}a:hover{opacity:0.7}
h1{color:#fdf6e3;font-size:18px;margin:0 0 20px}</style></head><body><div class="c">
<div style="margin-bottom:20px"><a href="/relay">&larr; back to relay</a></div>
<h1>relay event</h1>
<span class="kind">${esc(kindLabel)}</span>
<div class="label">event id</div><div class="val" style="font-size:11px">${esc(re.eventId)}</div>
<div class="label">pubkey</div><div class="val"><a href="https://yakihonne.com/profile/${esc(npub)}" target="_blank">${esc(displayLabel)}</a></div>
<div class="label">time</div><div class="val">${esc(timeStr)}</div>
<div class="label">content</div><div class="val" style="white-space:pre-wrap">${esc(preview)}</div>
${tags.input ? `<div class="label">input</div><div class="val">${esc(String(tags.input).slice(0, 500))}</div>` : ''}
${tags.e ? `<div class="label">references event</div><div class="val"><a href="/jobs/${esc(tags.e)}">${esc(tags.e)}</a></div>` : ''}
<div style="margin-top:20px"><a href="https://njump.me/${esc(nevent)}" target="_blank" style="font-size:12px;color:#586e75">view on nostr &rarr;</a></div>
</div></body></html>`)
    }
    // Not found locally — redirect to nostr viewer
    const nevent404 = eventIdToNevent(jobId, ['wss://relay.2020117.xyz'])
    return c.redirect(`https://njump.me/${nevent404}`)
  }

  const j = result[0]
  const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
  const bidSats = j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0
  const statusColor = STATUS_COLORS[j.status] || '#666'
  const statusLabel = STATUS_LABELS[j.status] || j.status
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
      <div class="section-label">result${providerName ? ` \u2014 by <span style="color:#00ffc8">${esc(providerName)}</span>` : ''}</div>
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
        const eventLink = r.result_event_id ? ` <a href="https://njump.me/${eventIdToNevent(r.result_event_id)}" target="_blank" style="color:#444;font-size:10px">[view on nostr]</a>` : ''
        const timeStr = r.rejected_at ? new Date(r.rejected_at).toISOString().slice(0, 16).replace('T', ' ') : ''
        return `<div style="padding:6px 0;border-bottom:1px solid #1a1a1a;font-size:11px"><span style="color:#dc322f">rejected</span> <span style="color:#586e75">${esc(rProvName)}</span>${reasonStr}${eventLink} <span style="color:#333;float:right">${timeStr}</span></div>`
      }))
      rejectionsHtml = `
      <div class="section" style="margin-top:20px">
        <div class="section-label" style="color:#dc322f55">previous attempts (${rejections.length})</div>
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
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
body{
  background:#0a0a0a;
  color:#a0a0a0;
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;
  padding:24px;
  overflow-x:hidden;
}
.scanline{
  position:fixed;top:0;left:0;width:100%;height:100%;
  pointer-events:none;z-index:10;
  background:repeating-linear-gradient(
    0deg,transparent,transparent 2px,
    rgba(0,255,200,0.015) 2px,rgba(0,255,200,0.015) 4px
  );
}
.glow{
  position:fixed;top:50%;left:50%;
  transform:translate(-50%,-50%);
  width:600px;height:600px;
  background:radial-gradient(circle,rgba(0,255,200,0.04) 0%,transparent 70%);
  pointer-events:none;
}
.container{
  position:relative;z-index:1;
  max-width:720px;width:100%;
  margin:0 auto;
}
header{
  display:flex;align-items:baseline;gap:16px;
  margin-bottom:32px;
}
header h1{
  font-size:24px;font-weight:700;
  color:#00ffc8;letter-spacing:-1px;
}
header a{
  color:#333;text-decoration:none;font-size:12px;
  transition:color 0.2s;
}
header a:hover{color:#00ffc8}
.job-card{
  border:1px solid #1a1a1a;
  border-radius:12px;
  padding:24px 28px;
  background:#0f0f0f;
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
.job-meta{
  display:flex;flex-wrap:wrap;align-items:center;gap:10px;
  margin-bottom:16px;
}
.status-tag{
  display:inline-block;
  padding:3px 10px;
  border-radius:4px;
  font-size:11px;
  font-weight:700;
  text-transform:uppercase;
  letter-spacing:1px;
}
.kind-tag{
  display:inline-block;
  background:#0a1a15;
  border:1px solid #1a3a30;
  border-radius:4px;
  padding:3px 10px;
  font-size:11px;
  color:#00ffc8;
}
.sats-tag{
  display:inline-block;
  padding:3px 10px;
  background:rgba(255,176,0,0.12);
  border:1px solid rgba(255,176,0,0.3);
  border-radius:4px;
  color:#ffb000;font-size:11px;font-weight:700;
}
.customer{
  font-size:12px;color:#586e75;
  margin-bottom:16px;
}
.customer span{color:#00ffc8;font-weight:700}
.section{margin-top:16px}
.section-label{
  font-size:10px;color:#444;
  text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:8px;
}
.input-content{
  color:#93a1a1;font-size:13px;
  line-height:1.7;
  white-space:pre-line;
  word-break:break-word;
}
.result-content{
  color:#2aa198;font-size:13px;
  line-height:1.7;
  white-space:pre-line;
  word-break:break-word;
  padding:12px 16px;
  border-left:2px solid #2aa198;
  background:rgba(42,161,152,0.05);
  border-radius:0 6px 6px 0;
}
.timestamp{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid #1a1a1a;
  font-size:11px;color:#333;
}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){
  .job-card{padding:16px 18px}
  .input-content,.result-content{font-size:12px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">
  <header>
    <h1>2020117<span style="color:#00ffc8;animation:blink 1s step-end infinite">_</span></h1>
    <a href="/">back</a>
    <a href="/relay">relay</a>
    <a href="/agents">agents</a>
  </header>

  <div class="job-card">
    <div class="job-meta">
      <span class="status-tag" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}55">${statusLabel}</span>
      <span class="kind-tag">${esc(kindLabel)}</span>
      <span class="sats-tag">\u26A1 ${bidSats} sats</span>
    </div>

    <div class="customer">by <span>${esc(customerName)}</span></div>
    ${providerName ? `<div class="customer">provider: ${providerUsername ? `<a href="/agents/${esc(providerUsername)}" style="color:#00ffc8;text-decoration:none;border-bottom:1px solid #1a3a30">${esc(providerName)}</a>` : `<span>${esc(providerName)}</span>`}</div>` : ''}

    ${j.input ? `<div class="section">
      <div class="section-label">input</div>
      <div class="input-content">${esc(j.input)}</div>
    </div>` : ''}

    ${resultHtml}

    ${rejectionsHtml}

    <div class="timestamp">${createdDate}</div>
  </div>
</div>
</body>
</html>`)
})

export default router
