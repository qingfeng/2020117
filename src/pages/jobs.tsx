import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { AppContext } from '../types'
import { PageLayout, type PageLayoutProps, avatarSrc } from '../components'

function pageLayout(opts: Omit<PageLayoutProps, 'children'>, content: string) {
  return <PageLayout {...opts}><div dangerouslySetInnerHTML={{ __html: content }} /></PageLayout>
}
import { getI18n } from '../lib/i18n'

// Shared CSS for job detail pages (used in both main path and fallback path)
const JOB_PAGE_CSS = `
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
  background:linear-gradient(135deg,color-mix(in srgb,var(--c-teal) 15%,transparent),transparent 50%);
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
  background:var(--badge-note-bg);
  border:1px solid var(--badge-note-border);
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
.section-label{color:var(--c-text-muted);font-size:11px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;font-weight:600}
.input-content{
  color:var(--c-text);font-size:15px;
  line-height:1.7;
  word-break:break-word;
}
.reply-block{
  margin-top:20px;
  padding-top:16px;
  border-top:1px solid var(--c-border);
}
.reply-head{
  display:flex;align-items:center;gap:8px;
  margin-bottom:12px;
}
.reply-avatar{
  width:28px;height:28px;border-radius:50%;object-fit:cover;flex-shrink:0;
}
.reply-name{
  color:var(--c-accent);text-decoration:none;font-weight:600;font-size:14px;
  border-bottom:1px solid var(--c-accent-dim);transition:opacity 0.15s;
}
.reply-name:hover{opacity:0.75}
.reply-label{
  font-size:12px;color:var(--c-text-dim);
  margin-left:2px;
}
.result-content{
  color:var(--c-text);font-size:15px;
  line-height:1.7;
  word-break:break-word;
}
.md-body{white-space:normal}
.md-body p{margin:0 0 0.8em;word-break:break-word}
.md-body p:last-child{margin-bottom:0}
.md-body h3,.md-body h4,.md-body h5,.md-body h6{margin:1em 0 0.4em;font-weight:700;color:var(--c-text)}
.md-body h3{font-size:1em}
.md-body h4,.md-body h5,.md-body h6{font-size:0.95em}
.md-body ul,.md-body ol{margin:0.5em 0 0.8em;padding-left:1.4em}
.md-body li{margin-bottom:0.25em}
.md-body code{font-family:monospace;font-size:0.88em;background:var(--c-surface2);padding:1px 5px;border-radius:3px}
.md-body pre{background:var(--c-surface2);border:1px solid var(--c-border);border-radius:6px;padding:12px;overflow-x:auto;margin:0.6em 0}
.md-body pre code{background:none;padding:0;font-size:0.85em}
.md-body blockquote{margin:0.5em 0;padding:6px 12px;border-left:2px solid var(--c-accent-dim);color:var(--c-text-dim);font-style:italic}
.md-body hr{border:none;border-top:1px solid var(--c-border);margin:1em 0}
.md-body a{color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)}
.md-body strong{font-weight:700;color:var(--c-text)}
.md-body em{font-style:italic}
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
.activity-item .actor{color:var(--c-accent);font-weight:700;text-decoration:none;transition:opacity 0.15s}
.activity-item .actor:hover{opacity:0.7}
.activity-item .status-processing{color:var(--c-teal)}
.activity-item .status-success{color:var(--c-accent)}
.activity-item .status-error{color:var(--c-red)}
.activity-item .status-payment{color:var(--c-gold)}
.activity-item .atime{color:var(--c-nav);font-size:12px;margin-left:auto;white-space:nowrap}
.review-block{
  margin-top:16px;padding:12px 16px;
  border:1px solid color-mix(in srgb,var(--c-magenta) 25%,transparent);border-radius:6px;
  background:color-mix(in srgb,var(--c-magenta) 6%,transparent);
}
.review-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.review-stars{color:var(--c-gold);font-size:16px;letter-spacing:1px}
.review-label{color:var(--c-magenta);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
.review-by{color:var(--c-text-muted);font-size:12px;margin-left:auto}
.review-text{color:var(--c-text-dim);font-size:14px;line-height:1.6;margin-top:4px}
.review-paid{
  display:inline-block;padding:2px 8px;
  background:var(--badge-note-bg);border:1px solid var(--badge-note-border);
  border-radius:4px;color:var(--c-gold);font-size:12px;font-weight:700;
}
.encrypted-badge{
  display:inline-flex;align-items:center;gap:6px;
  padding:6px 12px;border-radius:4px;font-size:13px;
  background:var(--badge-note-bg);border:1px solid var(--badge-note-border);
  color:var(--c-gold);
}
@media(max-width:480px){
  .job-card{padding:16px 18px}
  .input-content,.result-content{font-size:14px}
}
`

const router = new Hono<AppContext>()

// Lightweight markdown renderer (no deps, safe for Cloudflare Workers)
function renderMarkdown(raw: string): string {
  const he = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Inline markdown: escape HTML first, then apply patterns (& < > don't conflict with markdown syntax)
  function inline(text: string): string {
    let s = he(text)
    // Inline code (protect first)
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    // Bold+italic
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    // Bold
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    // Italic
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    // Links
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    return s
  }

  const lines = raw.split('\n')
  const out: string[] = []
  let i = 0

  const isSpecial = (l: string) =>
    l.startsWith('```') || /^#{1,6}\s/.test(l) || /^[-*+]\s/.test(l) ||
    /^\d+\.\s/.test(l) || l.startsWith('> ') || /^[-*_]{3,}$/.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = he(line.slice(3).trim())
      const block: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) { block.push(he(lines[i])); i++ }
      i++
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${block.join('\n')}</code></pre>`)
      continue
    }

    // Headings
    const hm = line.match(/^(#{1,6})\s+(.+)$/)
    if (hm) {
      const level = Math.min(hm[1].length + 2, 6)
      out.push(`<h${level}>${inline(hm[2])}</h${level}>`)
      i++; continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const qlines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) { qlines.push(inline(lines[i].slice(2))); i++ }
      out.push(`<blockquote>${qlines.join('<br>')}</blockquote>`)
      continue
    }

    // Unordered list
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^[-*+]\s/, ''))}</li>`); i++
      }
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    // Ordered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${inline(lines[i].replace(/^\d+\.\s/, ''))}</li>`); i++
      }
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line.trim())) { out.push('<hr>'); i++; continue }

    // Blank line
    if (line.trim() === '') { i++; continue }

    // Paragraph
    const plines: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !isSpecial(lines[i])) {
      plines.push(inline(lines[i])); i++
    }
    if (plines.length > 0) out.push(`<p>${plines.join('<br>')}</p>`)
  }

  return out.join('\n')
}

// Render DVM result content based on kind — returns HTML string or '' if no special handling
// Parse event IDs from a 6300 content discovery result (JSON tag array, possibly truncated)
function parseContentDiscoveryIds(content: string): string[] {
  const matches = [...content.matchAll(/"e",\s*"([0-9a-f]{64})"/g)]
  return matches.map(m => m[1])
}

// Render a compact summary of a 6300 content discovery result for the activity log
function renderContentDiscoverySummary(content: string, esc: (s: string) => string): string {
  const ids = parseContentDiscoveryIds(content)
  if (ids.length > 0) {
    const plus = content.endsWith('…') || content.endsWith('...') ? '+' : ''
    const links = ids.slice(0, 3).map(id =>
      `<a href="/notes/${esc(id)}" style="color:var(--c-accent);font-size:11px;font-family:monospace">${esc(id.slice(0, 16))}…</a>`
    ).join(', ')
    return `<div style="font-size:13px;color:var(--c-text-dim)">${ids.length}${plus} curated notes: ${links}${ids.length > 3 ? `, +${ids.length - 3} more` : ''}</div>`
  }
  const txt = content.trim()
  if (!txt || txt === 'None' || txt === 'null' || txt === '[]') return `<div style="color:var(--c-text-muted);font-size:13px">no notes curated</div>`
  return `<div style="color:var(--c-text-dim);font-size:13px">${esc(txt.slice(0, 200))}${txt.length > 200 ? '…' : ''}</div>`
}

// Resolve display name from Kind 0 profile (users table → relay_event cache → external relay fetch)
async function resolveDisplayName(db: any, env: any, pubkey: string): Promise<string | null> {
  const { relayEvents, users: usersTable } = await import('../db/schema')
  const { and } = await import('drizzle-orm')

  // 1. Check users table first — most authoritative and up-to-date
  const userResult = await db.select({ displayName: usersTable.displayName, username: usersTable.username })
    .from(usersTable).where(eq(usersTable.nostrPubkey, pubkey)).limit(1)
  if (userResult.length > 0) {
    const name = userResult[0].displayName || userResult[0].username
    if (name) return name
  }

  // 2. Check local Kind 0 cache
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
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'

  const { dvmJobs, users } = await import('../db/schema')
  const { and, or, sql: sqlRole } = await import('drizzle-orm')
  const { pubkeyToNpub, eventIdToNevent } = await import('../services/nostr')

  const DVM_KIND_LABELS: Record<number, string> = {
    5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'content discovery', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
  }

  const STATUS_COLORS: Record<string, string> = {
    open: 'var(--c-gold)', processing: 'var(--c-teal)', result_available: 'var(--c-blue)',
    completed: 'var(--c-accent)', cancelled: 'var(--c-text-muted)', error: 'var(--c-red)',
  }

  const STATUS_LABELS: Record<string, string> = {
    open: t.jobStatusOpen, processing: t.jobStatusProcessing, result_available: t.jobStatusResultAvailable,
    completed: t.jobStatusCompleted, cancelled: t.jobStatusCancelled, error: t.jobStatusError,
  }

  // Accept both platform job ID and Nostr event ID (from relay timeline)
  const result = await db.select({
    id: dvmJobs.id,
    kind: dvmJobs.kind,
    status: dvmJobs.status,
    input: dvmJobs.input,
    inputType: dvmJobs.inputType,
    result: dvmJobs.result,
    resultEventId: dvmJobs.resultEventId,
    params: dvmJobs.params,
    bidMsats: dvmJobs.bidMsats,
    priceMsats: dvmJobs.priceMsats,
    paidMsats: dvmJobs.paidMsats,
    providerPubkey: dvmJobs.providerPubkey,
    requestEventId: dvmJobs.requestEventId,
    eventId: dvmJobs.eventId,
    createdAt: dvmJobs.createdAt,
    updatedAt: dvmJobs.updatedAt,
    customerName: users.displayName,
    customerUsername: users.username,
    // customerPubkeyDirect: the canonical customer pubkey stored on the job record itself
    // (more reliable than users.nostrPubkey which is the job-owner's pubkey via userId join,
    //  and can be wrong when no customer role record exists)
    customerPubkeyDirect: dvmJobs.customerPubkey,
    customerPubkey: users.nostrPubkey,
    customerAvatarUrl: users.avatarUrl,
  }).from(dvmJobs)
    .leftJoin(users, eq(dvmJobs.userId, users.id))
    .where(or(eq(dvmJobs.id, jobId), eq(dvmJobs.eventId, jobId), eq(dvmJobs.requestEventId, jobId)))
    // Prefer: 1) customer role records, 2) provider records with known customer_pubkey
    .orderBy(sqlRole`CASE WHEN ${dvmJobs.role} = 'customer' THEN 0 WHEN ${dvmJobs.customerPubkey} IS NOT NULL THEN 1 ELSE 2 END`)
    .limit(1)

  // If the selected record (customer) lacks provider info, supplement from the provider record
  if (result.length > 0 && !result[0].providerPubkey) {
    const { isNotNull, and, or } = await import('drizzle-orm')
    const provRec = await db.select({
      providerPubkey: dvmJobs.providerPubkey,
      result: dvmJobs.result,
      resultEventId: dvmJobs.resultEventId,
      status: dvmJobs.status,
      priceMsats: dvmJobs.priceMsats,
      paidMsats: dvmJobs.paidMsats,
    }).from(dvmJobs)
      .where(and(
        or(eq(dvmJobs.id, jobId), eq(dvmJobs.eventId, jobId), eq(dvmJobs.requestEventId, jobId)),
        isNotNull(dvmJobs.providerPubkey)
      ))
      .limit(1)
    if (provRec.length > 0) {
      const pr = provRec[0]
      result[0].providerPubkey = pr.providerPubkey
      if (!result[0].result) result[0].result = pr.result
      if (!result[0].resultEventId) result[0].resultEventId = pr.resultEventId
      if (pr.status === 'completed' || pr.status === 'result_available') result[0].status = pr.status
      if (!result[0].priceMsats) result[0].priceMsats = pr.priceMsats
      if (!result[0].paidMsats) result[0].paidMsats = pr.paidMsats
    }
  }

  // Normalise customer pubkey: prefer dvmJobs.customerPubkey (the canonical field) over
  // users.nostrPubkey (which is the job-owner pubkey and wrong when no customer role record exists)
  if (result.length > 0) {
    const r = result[0]
    if (r.customerPubkeyDirect && r.customerPubkeyDirect !== r.customerPubkey) {
      // customerPubkey (from users join) is the provider's pubkey — look up the real customer
      const realCustomer = await db.select({
        displayName: users.displayName,
        username: users.username,
        avatarUrl: users.avatarUrl,
      }).from(users).where(eq(users.nostrPubkey, r.customerPubkeyDirect)).limit(1)
      r.customerPubkey = r.customerPubkeyDirect
      r.customerName = realCustomer[0]?.displayName || null
      r.customerUsername = realCustomer[0]?.username || ''
      r.customerAvatarUrl = realCustomer[0]?.avatarUrl || null
    }
    // Guard: if customer == provider, the join gave us the wrong record — clear customer info
    if (r.customerPubkey && r.providerPubkey && r.customerPubkey === r.providerPubkey) {
      r.customerName = null
      r.customerUsername = ''
      r.customerAvatarUrl = null
      r.customerPubkey = r.customerPubkeyDirect || null
    }
  }

  // If customerPubkey is still null (backfill missed), try to extract from result event's p tag
  if (result.length > 0 && !result[0].customerPubkey && result[0].resultEventId) {
    const { relayEvents: reSchema } = await import('../db/schema')
    const resultEvRow = await db.select({ tags: reSchema.tags })
      .from(reSchema)
      .where(eq(reSchema.eventId, result[0].resultEventId))
      .limit(1)
    if (resultEvRow.length > 0) {
      let rTags: Record<string, string> = {}
      try { rTags = JSON.parse(resultEvRow[0].tags || '{}') } catch {}
      if (rTags.p) {
        result[0].customerPubkey = rTags.p
        const custUser = await db.select({
          displayName: users.displayName,
          username: users.username,
          avatarUrl: users.avatarUrl,
        }).from(users).where(eq(users.nostrPubkey, rTags.p)).limit(1)
        result[0].customerName = custUser[0]?.displayName || null
        result[0].customerUsername = custUser[0]?.username || ''
        result[0].customerAvatarUrl = custUser[0]?.avatarUrl || null
      }
    }
  }

  if (result.length === 0) {
    // Fallback: show relay event detail for external DVM events not in dvm_job
    const { relayEvents } = await import('../db/schema')
    const relayRow = await db.select().from(relayEvents).where(eq(relayEvents.eventId, jobId)).limit(1)
    if (relayRow.length > 0) {
      const re = relayRow[0]
      const tags = re.tags ? JSON.parse(re.tags) : {}

      // 6xxx result event: redirect to the original 5xxx request page using the e tag
      if (re.kind >= 6000 && re.kind <= 6999 && tags.e) {
        return c.redirect(`/jobs/${tags.e}${lang ? '?lang=' + lang : ''}`, 301)
      }

      const kindLabel = DVM_KIND_LABELS[re.kind] || `kind ${re.kind}`
      const npub = pubkeyToNpub(re.pubkey)
      const resolvedName = await resolveDisplayName(db, c.env, re.pubkey)
      const displayLabel = resolvedName || npub
      const nevent = eventIdToNevent(re.eventId, ['wss://relay.2020117.xyz'], re.pubkey)

      // Look up requester in users table for avatar + local profile link
      const { users } = await import('../db/schema')
      const requesterUser = await db.select({
        displayName: users.displayName,
        username: users.username,
        avatarUrl: users.avatarUrl,
      }).from(users).where(eq(users.nostrPubkey, re.pubkey)).limit(1)
      const requesterUsername = requesterUser[0]?.username || null
      const requesterAvatarUrl = requesterUser[0]?.avatarUrl || null
      const timeIso = new Date(re.eventCreatedAt * 1000).toISOString()
      const timeStr = `<time datetime="${timeIso}">${timeIso.replace('T', ' ').slice(0, 19)}</time>`
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

      const isEncrypted = tags.encrypted === '1'

      // Fetch full event from relay to get complete input/content
      let fullInput: string | null = isEncrypted ? null : (tags.input || re.contentPreview || null)
      let resultPreview: string | null = null
      let resultProviderName: string | null = null
      let resultProviderPubkey: string | null = null

      if (!isEncrypted) try {
        const { fetchEventsFromRelay } = await import('../services/relay-io')
        const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
        const fullEventRes = await fetchEventsFromRelay(relayUrl, { ids: [re.eventId] })
        if (fullEventRes.events.length > 0) {
          const ev = fullEventRes.events[0]
          const iTag = ev.tags.find((t: string[]) => t[0] === 'i')
          fullInput = iTag?.[1] || ev.content || fullInput
        }
      } catch { /* use cached fallback */ }

      // For DVM request events (5xxx), look up the corresponding 6xxx result (skip if encrypted)
      if (!isEncrypted && re.kind >= 5000 && re.kind <= 5999) {
        try {
          const { fetchEventsFromRelay } = await import('../services/relay-io')
          const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
          const resultKind = re.kind + 1000
          const resultRes = await fetchEventsFromRelay(relayUrl, { kinds: [resultKind], '#e': [re.eventId], limit: 1 })
          if (resultRes.events.length > 0) {
            const rv = resultRes.events[0]
            resultPreview = rv.content || null
            resultProviderPubkey = rv.pubkey
            resultProviderName = await resolveDisplayName(db, c.env, rv.pubkey) || rv.pubkey.slice(0, 12) + '...'
          }
        } catch {
          // Fallback to relay_event cache
          const { and: andOp, sql: sqlOp } = await import('drizzle-orm')
          const resultRow = await db.select({
            contentPreview: relayEvents.contentPreview,
            pubkey: relayEvents.pubkey,
          }).from(relayEvents).where(
            andOp(
              sqlOp`${relayEvents.kind} >= 6000 AND ${relayEvents.kind} <= 6999`,
              sqlOp`instr(${relayEvents.tags}, ${re.eventId}) > 0`,
            )
          ).limit(1)
          if (resultRow.length > 0 && resultRow[0].contentPreview) {
            resultPreview = resultRow[0].contentPreview
            resultProviderPubkey = resultRow[0].pubkey
            resultProviderName = await resolveDisplayName(db, c.env, resultRow[0].pubkey) || resultRow[0].pubkey.slice(0, 12) + '...'
          }
        }
      }

      // Look up result provider in users table for avatar + local profile link
      let resultProviderUsername: string | null = null
      let resultProviderAvatarUrl: string | null = null
      if (resultProviderPubkey) {
        const provUser = await db.select({
          username: users.username,
          avatarUrl: users.avatarUrl,
        }).from(users).where(eq(users.nostrPubkey, resultProviderPubkey)).limit(1)
        resultProviderUsername = provUser[0]?.username || null
        resultProviderAvatarUrl = provUser[0]?.avatarUrl || null
      }

      // Fetch activity timeline (Kind 7000 feedback + 6xxx results) from relay_event cache
      const { sql: sqlRe } = await import('drizzle-orm')
      const activityRows = await db.select({
        eventId: relayEvents.eventId,
        kind: relayEvents.kind,
        pubkey: relayEvents.pubkey,
        contentPreview: relayEvents.contentPreview,
        tags: relayEvents.tags,
        eventCreatedAt: relayEvents.eventCreatedAt,
      }).from(relayEvents).where(
        sqlRe`instr(${relayEvents.tags}, ${re.eventId}) > 0 AND ${relayEvents.kind} IN (1, 7, 7000, 6100, 6200, 6250, 6300, 6301, 6302, 6303, 31117)`
      ).orderBy(relayEvents.eventCreatedAt).limit(20)

      // Build activity HTML
      const FEEDBACK_STATUS: Record<string, string> = { processing: t.jobStarted, success: t.jobCompleted, error: t.jobError, 'payment-required': t.jobPaymentRequired }
      let activityHtml = ''
      if (activityRows.length > 0) {
        const items = await Promise.all(activityRows.map(async (a) => {
          const rawAt = a.tags ? JSON.parse(a.tags) : []
          const atArr: string[][] = Array.isArray(rawAt) ? rawAt : []
          const atVal = (name: string) => atArr.find((t: string[]) => t[0] === name)?.[1] || ''
          const actorName = await resolveDisplayName(db, c.env, a.pubkey)
          const actorLabel = actorName || a.pubkey.slice(0, 12) + '...'
          const actorUser = await db.select({ username: users.username }).from(users).where(eq(users.nostrPubkey, a.pubkey)).limit(1)
          const actorUsername = actorUser[0]?.username || null
          const timeA = new Date(a.eventCreatedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
          let label = '', cls = '', reason = ''
          if (a.kind === 7000) {
            const status = atVal('status') || 'unknown'
            const isCustomer = a.pubkey === re.pubkey
            if (status === 'processing') { label = FEEDBACK_STATUS[status] || status; cls = 'status-processing' }
            else if (status === 'success') { label = FEEDBACK_STATUS[status] || status; cls = 'status-success' }
            else if (status === 'error' && isCustomer) { label = t.jobRejected; cls = 'status-error'; reason = a.contentPreview || '' }
            else if (status === 'error') { label = t.jobFailed; cls = 'status-error'; reason = a.contentPreview || '' }
            else if (status === 'payment-required') { label = FEEDBACK_STATUS[status] || status; cls = 'status-payment' }
            else { label = FEEDBACK_STATUS[status] || status; cls = '' }
            const amountMsats = atVal('amount') ? parseInt(atVal('amount')) : 0
            if (amountMsats > 0) label += ` — ${Math.floor(amountMsats / 1000)} sats`
          } else if (a.kind >= 6000 && a.kind <= 6999) {
            label = t.jobSubmittedResult; cls = 'status-success'
            const amountMsats = atVal('amount') ? parseInt(atVal('amount')) : 0
            if (amountMsats > 0) label += ` — ${Math.floor(amountMsats / 1000)} sats`
          } else if (a.kind === 1) {
            label = '💬 commented'; cls = ''
            reason = a.contentPreview || ''
          } else if (a.kind === 7) {
            const emoji = a.contentPreview || '+'
            label = emoji === '+' ? '❤ liked' : `${emoji} ${t.jobReacted}`; cls = 'status-success'
          } else if (a.kind === 31117) {
            const ratingV = atVal('rating'); const ratingN = ratingV ? parseInt(ratingV) : 0
            label = ratingN ? `${'★'.repeat(ratingN)}${'☆'.repeat(5 - ratingN)} reviewed` : 'reviewed'; cls = 'status-payment'
          } else { return '' }
          const reasonHtml = reason
            ? `<div style="margin-top:8px;width:100%;padding:10px 12px;background:var(--c-surface);border-left:3px solid var(--c-border);border-radius:0 6px 6px 0;color:var(--c-text);font-size:14px;line-height:1.7">${esc(reason.slice(0, 300))}</div>`
            : ''
          const actorHref = actorUsername ? `/agents/${esc(actorUsername)}` : `https://yakihonne.com/profile/${esc(pubkeyToNpub(a.pubkey))}`
          const actorExtra = actorUsername ? '' : ' target="_blank" rel="noopener"'
          return `<div class="activity-item" style="flex-wrap:wrap"><a class="actor" href="${actorHref}"${actorExtra}>${esc(actorLabel)}</a> <span class="${cls}">${esc(label)}</span><span class="atime">${timeA}</span>${reasonHtml}</div>`
        }))
        activityHtml = `<div class="activity-log"><div class="section-label">${esc(t.jobActivity)}</div>${items.filter(Boolean).join('')}</div>`
      }

      const isResultEvent = re.kind >= 6000 && re.kind <= 6999
      // For 6xxx result events, the content IS the result — move it to resultPreview for markdown rendering
      const inputText = isResultEvent ? null : fullInput
      const resultEventContent = isResultEvent ? fullInput : null
      // Build result block
      let fbResultHtml = ''
      if (isEncrypted) {
        fbResultHtml = `<div class="section"><div class="encrypted-badge">🔒 ${esc(t.jobEncrypted)}</div></div>`
      } else if (resultEventContent) {
        // 6xxx event: render own content as result with markdown
        const fbResultBody = `<div class="result-content md-body">${renderMarkdown(String(resultEventContent))}</div>`
        const provNpub = pubkeyToNpub(re.pubkey)
        const provNameHtml = `<a href="${requesterUsername ? '/agents/' + esc(requesterUsername) : 'https://yakihonne.com/profile/' + esc(provNpub)}" ${!requesterUsername ? 'target="_blank" rel="noopener"' : ''} class="reply-name">${esc(displayLabel)}</a>`
        fbResultHtml = `<div class="reply-block">
          <div class="reply-head">${requesterAvatarUrl ? `<img src="${esc(requesterAvatarUrl)}" class="reply-avatar" loading="lazy" aria-hidden="true">` : ''} ${provNameHtml}<span class="reply-label">${esc(t.jobResult)}</span></div>
          ${fbResultBody}
        </div>`
      } else if (resultPreview) {
        const provNpub = resultProviderPubkey ? pubkeyToNpub(resultProviderPubkey) : null
        const provAvatarSrc = avatarSrc(resultProviderPubkey, resultProviderAvatarUrl, 96)
        const provAvatarHtml = provAvatarSrc ? `<img src="${esc(provAvatarSrc)}" class="reply-avatar" loading="lazy" aria-hidden="true">` : ''
        const provNameHtml = resultProviderName
          ? (resultProviderUsername
            ? `<a href="/agents/${esc(resultProviderUsername)}" class="reply-name">${esc(resultProviderName)}</a>`
            : (provNpub ? `<a href="https://yakihonne.com/profile/${esc(provNpub)}" target="_blank" rel="noopener" class="reply-name">${esc(resultProviderName)}</a>` : `<span class="reply-name">${esc(resultProviderName)}</span>`))
          : ''
        const fbResultBody = re.kind === 5300
          ? `<div class="result-content">${renderContentDiscoverySummary(resultPreview, esc)}</div>`
          : `<div class="result-content md-body">${renderMarkdown(resultPreview)}</div>`
        fbResultHtml = `<div class="reply-block">
          <div class="reply-head">${provAvatarHtml}${provNameHtml}<span class="reply-label">${esc(t.jobResult)}</span></div>
          ${fbResultBody}
        </div>`
      }
      // Infer status from available data
      const fbStatus = resultPreview ? 'result_available' : 'open'
      const fbStatusLabel = resultPreview ? t.jobStatusResultAvailable : t.jobStatusOpen
      const fbStatusColor = resultPreview ? 'var(--c-blue)' : 'var(--c-gold)'

      const fbOgDesc = `${displayLabel}: ${(inputText || '').slice(0, 160)}`
      const fbLang = lang
      const fbQs = fbLang ? '?lang=' + fbLang : ''
      return c.html(pageLayout({
        title: `${esc(kindLabel)} \u2014 2020117`,
        description: esc(fbOgDesc),
        baseUrl,
        currentPath: '/jobs/' + re.eventId,
        lang: fbLang,
        headExtra: `<meta property="og:type" content="article">
<meta property="og:site_name" content="2020117">`,
        feedHeader: `<a href="/dvm/market${fbQs}" class="feed-back">← Market</a>${esc(kindLabel)}`,
        pageCSS: JOB_PAGE_CSS,
      }, `
  <article class="job-card">
    <div class="job-meta">
      <span class="status-tag" style="background:color-mix(in srgb,${fbStatusColor} 13%,transparent);color:${fbStatusColor};border:1px solid color-mix(in srgb,${fbStatusColor} 33%,transparent)">${esc(fbStatusLabel)}</span>
      <span class="kind-tag">${esc(kindLabel)}</span>
    </div>
    <div class="customer">${(() => {
      const cavSrc = avatarSrc(re.pubkey, requesterAvatarUrl, 96)
      const cavHtml = `<img src="${esc(cavSrc)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px;object-fit:cover" loading="lazy" aria-hidden="true">`
      const nameLink = requesterUsername
        ? `<a href="/agents/${esc(requesterUsername)}" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(displayLabel)}</a>`
        : `<a href="https://yakihonne.com/profile/${esc(npub)}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(displayLabel)}</a>`
      return `${esc(t.jobBy)} ${cavHtml}${nameLink}`
    })()}</div>
    ${(!isEncrypted && inputText) ? `<div class="section">
      <div class="section-label">${esc(t.jobInput)}</div>
      <div class="result-content md-body">${renderMarkdown(String(inputText))}</div>
    </div>` : ''}
    ${fbResultHtml}
    ${activityHtml}
    <div class="timestamp">
      ${timeStr}
      &nbsp;&middot;&nbsp;
      <a href="https://njump.me/${esc(nevent)}" target="_blank" rel="noopener" style="color:var(--c-nav)">nostr &rarr;</a>
      ${tags.e ? `&nbsp;&middot;&nbsp;<a href="/jobs/${esc(tags.e)}" style="color:var(--c-nav)">referenced job</a>` : ''}
    </div>
  </article>
`))
    }
    // Not found locally — redirect to nostr viewer
    const nevent404 = eventIdToNevent(jobId, ['wss://relay.2020117.xyz'])
    return c.redirect(`https://njump.me/${nevent404}`)
  }

  const j = result[0]
  const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
  const bidSats = j.bidMsats ? Math.floor(j.bidMsats / 1000) : 0
  const paidSats = j.paidMsats ? Math.floor(j.paidMsats / 1000) : (j.priceMsats ? Math.floor(j.priceMsats / 1000) : 0)
  // Status display will be determined after review check
  let effectiveStatus = j.status
  let customerName = j.customerName || j.customerUsername || ''
  // Resolve name from DB/relay if missing or a placeholder
  if ((!customerName || customerName.startsWith('nostr:')) && j.customerPubkey) {
    const resolved = await resolveDisplayName(db, c.env, j.customerPubkey)
    if (resolved) customerName = resolved
  }
  if (!customerName) customerName = 'unknown'

  // Look up provider
  let providerName = ''
  let providerUsername = ''
  let providerNpub = ''
  let providerAvatarUrl: string | null = null
  if (j.providerPubkey) {
    const prov = await db.select({
      displayName: users.displayName,
      username: users.username,
      nostrPubkey: users.nostrPubkey,
      avatarUrl: users.avatarUrl,
    }).from(users).where(eq(users.nostrPubkey, j.providerPubkey)).limit(1)

    if (prov.length > 0) {
      providerName = prov[0].displayName || prov[0].username || ''
      providerUsername = prov[0].username || ''
      providerNpub = prov[0].nostrPubkey ? pubkeyToNpub(prov[0].nostrPubkey) : ''
      providerAvatarUrl = prov[0].avatarUrl || null
    } else {
      providerNpub = pubkeyToNpub(j.providerPubkey)
      const resolved = await resolveDisplayName(db, c.env, j.providerPubkey)
      providerName = resolved || j.providerPubkey.slice(0, 12) + '...'
    }
  }

  // Fetch review: try dvmReviews table first, fallback to relay_events Kind 31117
  const { dvmReviews, relayEvents } = await import('../db/schema')
  const { sql: sqlTag } = await import('drizzle-orm')
  const requestEventId = j.requestEventId || j.eventId || ''

  type ReviewData = { rating: number; content: string | null; role: string; reviewerName: string | null; createdAt: Date }
  let reviewInfo: ReviewData | null = null

  // Source 1: dvmReviews table (indexed by pollJobReviews cron)
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

  // Source 2: relay_events Kind 31117 or 30311 — pick most recent by Nostr event timestamp.
  // Kind 30311 is replaceable so relay_events always has the latest version.
  // dvmReviews.createdAt is DB insert time (not Nostr event time), so always prefer
  // relay_events when it carries a valid rating tag.
  if (requestEventId) {
    const { desc: descOrder } = await import('drizzle-orm')
    const relayReviews = await db.select({
      pubkey: relayEvents.pubkey,
      contentPreview: relayEvents.contentPreview,
      tags: relayEvents.tags,
      eventCreatedAt: relayEvents.eventCreatedAt,
    }).from(relayEvents).where(
      sqlTag`${relayEvents.kind} IN (31117, 30311) AND instr(${relayEvents.tags}, ${requestEventId}) > 0`
    ).orderBy(descOrder(relayEvents.eventCreatedAt)).limit(1)
    if (relayReviews.length > 0) {
      const re = relayReviews[0]
      // tags is stored as a JSON object (not array) by extractKeyTags
      const tagsObj: Record<string, string> = re.tags ? JSON.parse(re.tags) : {}
      const relayRating = tagsObj.rating ? parseInt(tagsObj.rating) : null
      if (relayRating !== null) {
        const reviewerName = await resolveDisplayName(db, c.env, re.pubkey)
        reviewInfo = {
          rating: Math.min(5, Math.max(1, relayRating)),
          content: re.contentPreview || null,
          role: tagsObj.role || 'customer',
          reviewerName: reviewerName || re.pubkey.slice(0, 12) + '...',
          createdAt: new Date(re.eventCreatedAt * 1000),
        }
      } else if (!reviewInfo) {
        const reviewerName = await resolveDisplayName(db, c.env, re.pubkey)
        reviewInfo = {
          rating: 0,
          content: re.contentPreview || null,
          role: tagsObj.role || 'customer',
          reviewerName: reviewerName || re.pubkey.slice(0, 12) + '...',
          createdAt: new Date(re.eventCreatedAt * 1000),
        }
      }
    }
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
        sqlTag`${relayEvents.kind} IN (1, 7, 7000, 6100, 6200, 6250, 6300, 6301, 6302, 6303, 31117)`,
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

  // Format timestamp (ISO for <time> tag, JS will localize on client)
  const createdDate = j.createdAt instanceof Date ? j.createdAt.toISOString() : new Date(j.createdAt as any).toISOString()
  const localTime = (iso: string) => `<time datetime="${esc(iso)}">${esc(iso.slice(0, 16).replace('T', ' '))}</time>`

  // Build result section
  // inputType may be 'text' (default) for old encrypted jobs where backfill failed — treat as encrypted
  // if input is null: either explicitly encrypted, or a failed backfill that set no input
  const jobIsEncrypted = j.inputType === 'encrypted' || !j.input

  // Fetch full content for ALL 6xxx events in the activity log (including rejected ones)
  // Batch into a single relay request so we can display each provider's submission
  const activityResultContent = new Map<string, string>()
  const activityResultIds = jobActivity.filter(a => a.kind >= 6100 && a.kind <= 6303).map(a => a.eventId)
  if (activityResultIds.length > 0) {
    try {
      const { fetchEventsFromRelay: ferBatch } = await import('../services/relay-io')
      const _relayUrlBatch = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
      const { events: batchEvs } = await ferBatch(_relayUrlBatch, { ids: activityResultIds, limit: activityResultIds.length })
      for (const ev of batchEvs) activityResultContent.set(ev.id, ev.content || '')
    } catch { /* use contentPreview fallback */ }
  }

  // Batch-fetch curated note content for all 6300 results in activity log
  const activityNoteMap = new Map<string, string>()
  {
    const allCuratedIds: string[] = []
    for (const a of jobActivity.filter(a => a.kind === 6300)) {
      const raw = activityResultContent.get(a.eventId) || a.contentPreview || ''
      for (const id of parseContentDiscoveryIds(raw)) {
        if (!allCuratedIds.includes(id)) allCuratedIds.push(id)
      }
    }
    if (allCuratedIds.length > 0) {
      try {
        const { fetchEventsFromRelay: ferAct } = await import('../services/relay-io')
        const ids = allCuratedIds.slice(0, 40)
        const relayUrls = [c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz', 'wss://relay.damus.io', 'wss://nos.lol']
        for (const ru of relayUrls) {
          try {
            const { events: noteEvs } = await ferAct(ru, { ids, limit: ids.length })
            for (const ev of noteEvs) activityNoteMap.set(ev.id, ev.content || '')
            if (activityNoteMap.size >= ids.length) break
          } catch {}
        }
      } catch {}
    }
  }

  // Fetch full result from relay using result_event_id (DB may have truncated content_preview)
  // Note: even if the request was encrypted, the result (provider's response) is typically plaintext
  let resultText: string | null = null
  const resultEventId = j.resultEventId || jobActivity.find(a => a.kind >= 6100 && a.kind <= 6303)?.eventId || null
  if (resultEventId) {
    // Already fetched in batch above if it's in activityResultIds
    resultText = activityResultContent.get(resultEventId) || null
    if (!resultText) {
      try {
        const { fetchEventsFromRelay: fer } = await import('../services/relay-io')
        const _relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
        const { events: rEvs } = await fer(_relayUrl, { ids: [resultEventId], limit: 1 })
        if (rEvs.length > 0) resultText = rEvs[0].content || null
      } catch { /* fall back to DB */ }
    }
  }
  if (!resultText) {
    resultText = j.result || jobActivity.find(a => a.kind >= 6100 && a.kind <= 6303)?.contentPreview || null
  }

  let resultHtml = ''
  if (resultText) {
    const j_result_compat = resultText
    let resultBody = ''
    if (j.kind === 5300) {
      // Content discovery: result is a JSON array of e-tags pointing to curated notes
      const curatedIds = parseContentDiscoveryIds(j_result_compat)
      if (curatedIds.length > 0) {
        // Fetch note content from relay
        const noteRowMap = new Map<string, string>()
        try {
          const { fetchEventsFromRelay: ferNotes } = await import('../services/relay-io')
          const ids = curatedIds.slice(0, 10)
          const relayUrls = [c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz', 'wss://relay.damus.io', 'wss://nos.lol']
          for (const ru of relayUrls) {
            try {
              const res = await ferNotes(ru, { ids, limit: ids.length })
              for (const ev of res.events) if (!noteRowMap.has(ev.id)) noteRowMap.set(ev.id, ev.content || '')
              if (noteRowMap.size >= ids.length) break
            } catch {}
          }
        } catch {}
        const noteRows = [...noteRowMap.entries()].map(([id, content]) => ({ id, content }))
        const noteMap = new Map(noteRows.map(r => [r.id, r.content]))
        const plus = j_result_compat.endsWith('…') || j_result_compat.endsWith('...') ? '+' : ''
        const items = curatedIds.map(id => {
          const text = noteMap.get(id)
          return text
            ? `<a href="/notes/${esc(id)}" style="display:block;padding:10px 0;border-bottom:1px solid var(--c-border);color:var(--c-text-dim);text-decoration:none;font-size:13px;line-height:1.6" onmouseover="this.style.color='var(--c-text)'" onmouseout="this.style.color='var(--c-text-dim)'">${esc(text.slice(0, 280))}${text.length > 280 ? '…' : ''}</a>`
            : `<a href="/notes/${esc(id)}" style="display:block;padding:8px 0;border-bottom:1px solid var(--c-border);color:var(--c-accent);font-family:monospace;font-size:11px">${esc(id.slice(0, 32))}…</a>`
        }).join('')
        resultBody = `<div style="margin-top:6px"><div style="font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${curatedIds.length}${plus} curated notes</div>${items}</div>`
      } else {
        resultBody = `<div class="result-content md-body">${renderMarkdown(j_result_compat)}</div>`
      }
    } else {
      let imgSrc = ''
      if (j_result_compat.startsWith('data:image/')) {
        imgSrc = j_result_compat
      } else {
        try {
          const parsed = JSON.parse(j_result_compat)
          if (parsed.type === 'image' && parsed.data) {
            const fmt = parsed.format || 'png'
            imgSrc = `data:image/${fmt};base64,${parsed.data}`
          }
        } catch {}
      }
      resultBody = imgSrc
        ? `<img src="${imgSrc}" alt="Generated image" style="max-width:100%;border-radius:6px">`
        : `<div class="result-content md-body">${renderMarkdown(j_result_compat)}</div>`
    }
    resultHtml = `
    <div class="reply-block">
      <div class="reply-head">${(() => {
        const pavSrc = avatarSrc(j.providerPubkey, providerAvatarUrl, 96)
        const pavHtml = pavSrc ? `<img src="${esc(pavSrc)}" class="reply-avatar" loading="lazy" aria-hidden="true">` : ''
        const pLink = providerName ? (providerUsername ? `<a href="/agents/${esc(providerUsername)}" class="reply-name">${esc(providerName)}</a>` : `<a href="https://yakihonne.com/profile/${esc(providerNpub)}" target="_blank" rel="noopener" class="reply-name">${esc(providerName)}</a>`) : ''
        return `${pavHtml}${pLink}<span class="reply-label">${esc(t.jobResult)}</span>`
      })()}</div>
      ${resultBody}
    </div>`
  } else if (jobIsEncrypted) {
    resultHtml = `<div class="section"><div class="encrypted-badge">🔒 ${esc(t.jobEncrypted)}</div></div>`
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
        const rejIso = r.rejected_at ? new Date(r.rejected_at).toISOString() : ''
        const timeStr = rejIso ? `<time datetime="${esc(rejIso)}">${rejIso.slice(0, 16).replace('T', ' ')}</time>` : ''
        return `<div style="padding:6px 0;border-bottom:1px solid var(--c-border);font-size:13px"><span style="color:var(--c-red)">rejected</span> <span style="color:var(--c-text-dim)">${esc(rProvName)}</span>${reasonStr}${eventLink} <span style="color:var(--c-nav);float:right">${timeStr}</span></div>`
      }))
      rejectionsHtml = `
      <div class="section" style="margin-top:20px">
        <div class="section-label" style="color:color-mix(in srgb,var(--c-red) 33%,transparent)">previous attempts (${rejections.length})</div>
        ${items.join('')}
      </div>`
    }
  } catch {}

  const jobHeadExtra = `<meta property="og:title" content="${esc(ogTitle)} \u2014 2020117">
<meta property="og:description" content="${ogDesc}">
<meta property="og:type" content="article">
<meta property="og:url" content="${baseUrl}/jobs/${j.id}">
<meta property="og:image" content="${baseUrl}/logo-512.png?v=2">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(ogTitle)} \u2014 2020117">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${baseUrl}/logo-512.png?v=2">
<link rel="canonical" href="${baseUrl}/jobs/${j.id}">`
  const jobQs = lang ? '?lang=' + lang : ''

  return c.html(pageLayout({
    title: `${esc(kindLabel)} \u2014 2020117`,
    description: ogDesc,
    baseUrl,
    currentPath: '/jobs/' + jobId,
    lang,
    feedHeader: `<a href="/dvm/market${jobQs}" style="color:var(--c-text-muted);text-decoration:none;font-size:14px">\u2190 Market</a>`,
    headExtra: jobHeadExtra,
    pageCSS: JOB_PAGE_CSS,
    scripts: `<script>document.querySelectorAll('time[datetime]').forEach(el=>{const d=new Date(el.getAttribute('datetime'));if(!isNaN(d)){el.textContent=d.toLocaleString(undefined,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}})</script>`,
  }, `

  <main>
  <article class="job-card">
    <div class="job-meta">
      <span class="status-tag" style="background:color-mix(in srgb,${statusColor} 13%,transparent);color:${statusColor};border:1px solid color-mix(in srgb,${statusColor} 33%,transparent)">${statusLabel}</span>
      <span class="kind-tag">${esc(kindLabel)}</span>
      ${paidSats > 0 ? `<span class="sats-tag">\u26A1 ${paidSats} sats</span>` : bidSats > 0 ? `<span class="sats-tag" title="bid">\u26A1 ${bidSats} sats bid</span>` : ''}
      ${requestEventId ? `<button onclick="navigator.clipboard.writeText('${esc(requestEventId)}').then(()=>{this.textContent='copied!';setTimeout(()=>{this.textContent='copy id'},1500)})" style="margin-left:auto;background:none;border:1px solid var(--c-border);color:var(--c-nav);font-size:11px;padding:2px 8px;border-radius:4px;cursor:pointer;letter-spacing:0.5px;transition:color 0.2s,border-color 0.2s" onmouseover="this.style.color='var(--c-accent)';this.style.borderColor='var(--c-accent)'" onmouseout="this.style.color='var(--c-nav)';this.style.borderColor='var(--c-border)'">copy id</button>` : ''}
    </div>

    <div class="customer">${(() => {
      const cavSrc = avatarSrc(j.customerPubkey, j.customerAvatarUrl, 96)
      const cavHtml = cavSrc ? `<img src="${esc(cavSrc)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px;object-fit:cover" loading="lazy" aria-hidden="true">` : ''
      const nameHtml = j.customerUsername ? `<a href="/agents/${esc(j.customerUsername)}" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(customerName)}</a>` : (j.customerPubkey ? `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(j.customerPubkey))}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(customerName)}</a>` : `<span>${esc(customerName)}</span>`)
      return `${esc(t.jobBy)} ${cavHtml}${nameHtml}`
    })()}</div>
    ${providerName ? `<div class="customer">${(() => {
      const pavSrc = avatarSrc(j.providerPubkey, providerAvatarUrl, 96)
      const pavHtml = pavSrc ? `<img src="${esc(pavSrc)}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:6px;object-fit:cover" loading="lazy" aria-hidden="true">` : ''
      const pNameHtml = providerUsername ? `<a href="/agents/${esc(providerUsername)}" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(providerName)}</a>` : `<a href="https://yakihonne.com/profile/${esc(providerNpub)}" target="_blank" rel="noopener" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">${esc(providerName)}</a>`
      return `${esc(t.jobProvider)}: ${pavHtml}${pNameHtml}`
    })()}</div>` : ''}

    ${jobIsEncrypted ? `<div class="section"><div class="encrypted-badge">🔒 ${esc(t.jobEncrypted)}</div></div>` : j.input ? `<div class="section">
      <div class="section-label">${esc(t.jobInput)}</div>
      <div class="result-content md-body">${(() => {
        const raw = j.input!
        // For content discovery: input may be a nevent/note reference or JSON event array
        if (j.kind === 5300) {
          const neventMatch = raw.match(/nevent1[a-z0-9]+|note1[a-z0-9]+/)
          if (neventMatch) return `🔊 convert to speech: <a href="/jobs/${esc(neventMatch[0])}" style="color:var(--c-accent)">${esc(neventMatch[0].slice(0, 30))}…</a>`
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) {
              const eIds = parsed.filter((t: string[]) => t[0] === 'e').map((t: string[]) => t[1])
              if (eIds.length > 0) return `🔊 convert to speech: ${eIds.length} note${eIds.length > 1 ? 's' : ''} (${esc(eIds[0].slice(0, 12))}…)`
            }
          } catch {}
        }
        return renderMarkdown(raw)
      })()}</div>
    </div>` : ''}

    ${resultHtml}

    ${reviewInfo ? `<div class="review-block">
      <div class="review-head">
        <span class="review-stars">${'★'.repeat(reviewInfo.rating)}${'☆'.repeat(5 - reviewInfo.rating)}</span>
        <span class="review-label">${esc(t.jobReviewEndorsement)}</span>
        ${paidSats > 0 ? `<span class="review-paid">⚡ ${paidSats} sats paid</span>` : ''}
        <span class="review-by">by ${esc(reviewInfo.reviewerName || 'unknown')}</span>
      </div>
      ${reviewInfo.content ? `<div class="review-text">${esc(reviewInfo.content)}</div>` : ''}
    </div>` : ''}

    ${rejectionsHtml}

    ${effectiveStatus === 'open' ? `<div style="margin:16px 0;padding:10px 14px;background:color-mix(in srgb,var(--c-teal) 6%,transparent);border:1px solid color-mix(in srgb,var(--c-teal) 20%,transparent);border-radius:6px;font-size:13px;color:var(--c-teal)">&#x25CF; This job is still open — providers can submit a better result</div>` : ''}

    ${jobActivity.length > 0 ? `<div class="activity-log">
      <div class="section-label">${esc(t.jobActivity)}</div>
      ${(() => {
        const renderItem = (a: ActivityRow, skipActor = false) => {
          const actor = activityActors.get(a.pubkey) || { name: pubkeyToNpub(a.pubkey).slice(0, 16) + '...', username: '' }
          const rawTags = a.tags ? JSON.parse(a.tags) : []
          const tagArr2: string[][] = Array.isArray(rawTags) ? rawTags : []
          const tagVal2 = (name: string) => tagArr2.find((t: string[]) => t[0] === name)?.[1] || ''
          const aTimeIso = new Date(a.eventCreatedAt * 1000).toISOString()
          const aTime = `<time datetime="${esc(aTimeIso)}">${aTimeIso.slice(0, 16).replace('T', ' ')}</time>`
          let label = '', cls = '', reason = '', resultPreview = ''
          if (a.kind === 7000) {
            const st = tagVal2('status') || 'update'
            const isCustomer = a.pubkey === j.customerPubkey
            if (st === 'processing') { label = t.jobStarted; cls = 'status-processing' }
            else if (st === 'success') { label = t.jobCompleted; cls = 'status-success' }
            else if (st === 'error' && isCustomer) { label = t.jobRejected; cls = 'status-error'; reason = a.contentPreview || '' }
            else if (st === 'error') { label = t.jobFailed; cls = 'status-error'; reason = a.contentPreview || '' }
            else if (st === 'payment-required') { label = t.jobPaymentRequired; cls = 'status-payment' }
            else { label = st; cls = '' }
          } else if (a.kind >= 6100 && a.kind <= 6303) {
            label = t.jobSubmittedResult; cls = 'status-success'
            if (!jobIsEncrypted) {
              const content = activityResultContent.get(a.eventId) || a.contentPreview || ''
              if (content) resultPreview = content.length > 500 ? content.slice(0, 500) + '…' : content
            }
          } else if (a.kind === 1) {
            label = '💬 commented'; cls = ''
            reason = a.contentPreview || ''
          } else if (a.kind === 7) {
            const emoji = a.contentPreview || '+'; label = emoji === '+' ? '❤ liked' : `${emoji} reacted`; cls = 'status-success'
          } else if (a.kind === 31117) {
            const ratingVal = tagVal2('rating'); label = ratingVal ? `reviewed (${'★'.repeat(parseInt(ratingVal))}${'☆'.repeat(5 - parseInt(ratingVal))})` : 'reviewed'; cls = 'status-payment'
          } else { return '' }
          const actorHtml = skipActor ? '' : (actor.username
            ? `<a class="actor" href="/agents/${esc(actor.username)}">${esc(actor.name)}</a> `
            : `<a class="actor" href="https://yakihonne.com/profile/${esc(pubkeyToNpub(a.pubkey))}" target="_blank" rel="noopener">${esc(actor.name)}</a> `)
          const reasonHtml = reason
            ? `<div style="margin-top:8px;width:100%;padding:10px 12px;background:var(--c-surface);border-left:3px solid var(--c-border);border-radius:0 6px 6px 0;color:var(--c-text);font-size:14px;line-height:1.7">${esc(reason.slice(0, 300))}</div>`
            : ''
          let resultPreviewHtml = ''
          if (resultPreview) {
            let dvmHtml: string | null = null
            if (a.kind === 6300) {
              const ids = parseContentDiscoveryIds(resultPreview)
              if (ids.length > 0) {
                const plus = resultPreview.endsWith('…') || resultPreview.endsWith('...') ? '+' : ''
                const noteItems = ids.map(id => {
                  const text = activityNoteMap.get(id)
                  return text
                    ? `<div style="padding:5px 0;border-bottom:1px solid var(--c-border);font-size:12px;color:var(--c-text-dim);line-height:1.5">${esc(text.slice(0, 140))}${text.length > 140 ? '…' : ''}</div>`
                    : `<a href="/notes/${esc(id)}" style="display:block;padding:3px 0;color:var(--c-accent);font-size:11px;font-family:monospace">${esc(id.slice(0, 16))}…</a>`
                }).join('')
                dvmHtml = `<div style="font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${ids.length}${plus} curated notes</div>${noteItems}`
              } else {
                dvmHtml = renderContentDiscoverySummary(resultPreview, esc)
              }
            }
            resultPreviewHtml = dvmHtml
              ? `<div style="margin-top:6px;padding:8px 10px;background:var(--c-surface);border-left:2px solid var(--c-border);border-radius:0 4px 4px 0;width:100%">${dvmHtml}</div>`
              : `<div style="color:var(--c-text-dim);font-size:12px;margin-top:6px;padding:8px 10px;background:var(--c-surface);border-left:2px solid var(--c-border);border-radius:0 4px 4px 0;white-space:pre-wrap;max-height:160px;overflow:hidden;width:100%;line-height:1.5">${esc(resultPreview)}</div>`
          }
          return `<div class="activity-item" style="flex-wrap:wrap">${actorHtml}<span class="${cls}">${label}</span><span class="atime">${aTime}</span>${reasonHtml}${resultPreviewHtml}</div>`
        }
        const providerEvents = jobActivity.filter(a => a.pubkey !== j.customerPubkey)
        const customerFeedback = jobActivity.filter(a => a.pubkey === j.customerPubkey && a.kind === 7000)
        const providerOrder = [...new Set(providerEvents.map(a => a.pubkey))]
        if (providerOrder.length <= 1) {
          return jobActivity.map(a => renderItem(a)).filter(Boolean).join('\n      ')
        }
        return providerOrder.map(pk => {
          const actor = activityActors.get(pk) || { name: pubkeyToNpub(pk).slice(0, 16) + '...', username: '' }
          const events = providerEvents.filter(a => a.pubkey === pk)
          const feedback = customerFeedback.filter(a => {
            const ptags = a.tags ? JSON.parse(a.tags) : []
            return Array.isArray(ptags) && ptags.some((t: string[]) => t[0] === 'p' && t[1] === pk)
          })
          const headerLink = actor.username
            ? `<a href="/agents/${esc(actor.username)}" style="color:var(--c-accent);font-weight:700;font-size:12px;text-decoration:none">${esc(actor.name)}</a>`
            : `<a href="https://yakihonne.com/profile/${esc(pubkeyToNpub(pk))}" target="_blank" rel="noopener" style="color:var(--c-accent);font-weight:700;font-size:12px;text-decoration:none">${esc(actor.name)}</a>`
          const items = [...events, ...feedback].sort((a, b) => a.eventCreatedAt - b.eventCreatedAt)
            .map(a => renderItem(a, a.pubkey === pk)).filter(Boolean).join('\n')
          return `<div style="border-left:2px solid var(--c-border);padding-left:10px;margin-bottom:10px"><div style="font-size:11px;color:var(--c-text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.5px">provider: ${headerLink}</div>${items}</div>`
        }).join('\n')
      })()}
    </div>` : ''}

    <div class="timestamp"><time datetime="${esc(createdDate)}">${createdDate}</time></div>
  </article>
`))
})

export default router
