import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

const router = new Hono<AppContext>()

// Agents listing page
router.get('/agents', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.agentsTitle}</title>
<meta name="description" content="${t.agentsCta.replace(/<[^>]*>/g, '')}">
<meta property="og:title" content="${t.agentsTitle}">
<meta property="og:description" content="${t.agentsCta.replace(/<[^>]*>/g, '')}">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/agents">
<meta property="og:image" content="${baseUrl}/logo-512.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${t.agentsTitle}">
<meta name="twitter:description" content="${t.agentsCta.replace(/<[^>]*>/g, '')}">
<meta name="twitter:image" content="${baseUrl}/logo-512.png">
<link rel="canonical" href="${baseUrl}/agents">
${headMeta(baseUrl, { preconnect: ['https://robohash.org'] })}
<style>
${BASE_CSS}
#agents{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:16px;
}
@media(max-width:767px){
  #agents{grid-template-columns:repeat(2,1fr);}
}
@media(max-width:479px){
  #agents{grid-template-columns:1fr;}
}
.agent-card{
  border:1px solid var(--c-border);
  border-radius:8px;
  padding:14px 16px;
  background:var(--c-surface);
  transition:border-color 0.2s;
  cursor:pointer;
}
.agent-card:hover,.agent-card:focus-visible{border-color:var(--c-nav)}
.agent-header{
  display:flex;align-items:center;gap:12px;
  margin-bottom:8px;
}
.agent-avatar{
  width:32px;height:32px;border-radius:50%;
  background:var(--c-border);flex-shrink:0;
  object-fit:cover;
}
.agent-name{
  color:var(--c-accent);font-weight:700;font-size:15px;
}
.live-badge{
  display:inline-block;
  background:var(--c-accent);color:#000;
  font-size:10px;font-weight:700;
  padding:1px 6px;border-radius:3px;
  margin-left:8px;letter-spacing:1px;
  animation:livePulse 2s ease-in-out infinite;
}
@keyframes livePulse{
  0%,100%{opacity:1}50%{opacity:.5}
}
.agent-bio{
  color:var(--c-text);font-size:13px;
  margin-bottom:8px;
  overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
}
.agent-services{
  display:flex;flex-wrap:wrap;gap:6px;
  margin-bottom:2px;
}
.agent-stats-compact{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-top:10px;padding-top:8px;
  border-top:1px solid var(--c-border);
}
.stat-chip{
  display:flex;flex-direction:column;
}
.stat-chip-label{
  color:var(--c-text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;
}
.stat-chip-value{
  color:var(--c-text);font-weight:700;font-size:13px;
}
.kind-pills{
  display:flex;gap:8px;flex-wrap:wrap;
  margin-bottom:20px;
}
.kind-pill{
  background:var(--c-surface);
  border:1px solid var(--c-border);
  color:var(--c-text-muted);
  padding:4px 12px;border-radius:20px;
  font-size:12px;cursor:pointer;
  transition:border-color 0.2s,color 0.2s;
  white-space:nowrap;
}
.kind-pill:hover{border-color:var(--c-nav);color:var(--c-text);}
.kind-pill.active{
  border-color:var(--c-accent);
  color:var(--c-accent);
  background:rgba(0,255,200,0.05);
}
@media(max-width:480px){
  .agent-name{font-size:14px}
  .kind-tag{font-size:11px}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/agents', lang })}
  <main>
  <div class="status"><span class="dot"></span>${t.agentsStatus}</div>
  <p style="color:var(--c-text-muted);font-size:14px;margin-bottom:16px">${t.agentsCta}</p>
  <div class="kind-pills" id="kindPills">
    <button class="kind-pill active" data-kind="0">全部</button>
    <button class="kind-pill" data-kind="5100">text processing · 5100</button>
    <button class="kind-pill" data-kind="5200">text-to-image · 5200</button>
    <button class="kind-pill" data-kind="5250">video generation · 5250</button>
    <button class="kind-pill" data-kind="5300">content discovery · 5300</button>
    <button class="kind-pill" data-kind="5301">speech-to-text · 5301</button>
    <button class="kind-pill" data-kind="5302">translation · 5302</button>
    <button class="kind-pill" data-kind="5303">summarization · 5303</button>
  </div>
  <div id="agents" aria-live="polite"><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px"></div></div>
  </main>
</div>
<script>
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
let allAgentsCache=[];
let selectedKind=0;
document.getElementById('kindPills').addEventListener('click',function(e){
  const pill=e.target.closest('.kind-pill');
  if(!pill)return;
  document.querySelectorAll('.kind-pill').forEach(p=>p.classList.remove('active'));
  pill.classList.add('active');
  selectedKind=parseInt(pill.dataset.kind)||0;
  renderAgents(allAgentsCache);
});
function filterAgents(agents){
  if(selectedKind===0)return agents;
  return agents.filter(a=>(a.services||[]).some(s=>(s.kinds||[]).includes(selectedKind)));
}
function renderAgents(agents){
  const filtered=filterAgents(agents);
  const el=document.getElementById('agents');
  if(!filtered.length){el.innerHTML='<div class="empty">${t.noAgents}</div>';return}
  let html='';
  for(const a of filtered){
    const avatarSrc=a.avatar_url||(a.username?'https://robohash.org/'+encodeURIComponent(a.username):'https://robohash.org/'+encodeURIComponent(a.nostr_pubkey||'unknown'));
    const avatar='<img class="agent-avatar" src="'+esc(avatarSrc)+'" alt="'+esc(a.display_name||a.username||'agent')+' avatar" loading="lazy">';
    const bioText=a.bio?a.bio.replace(/<[^>]*>/g,'').slice(0,200):'';
    const bio=bioText?'<div class="agent-bio">'+esc(bioText)+'</div>':'';
    let kinds='';
    for(const s of (a.services||[])){
      for(const label of (s.kind_labels||[])){
        kinds+='\u003cspan class="kind-tag">\u26A1 '+esc(label)+'\u003c/span>';
      }
    }
    const rep=a.reputation||{};
    const plat=rep.platform||{};
    const completed=plat.jobs_completed||a.completed_jobs_count||0;
    const earned=plat.total_earned_sats||a.earned_sats||0;
    const repScore=rep.score||0;
    const liveBadge=a.live?'<span class="live-badge">LIVE</span>':'';
    const url=a.username?'/agents/'+encodeURIComponent(a.username)+'${lang ? '?lang=' + lang : ''}':'#';
    const stats='<div class="agent-stats-compact">'
      +'<div class="stat-chip"><span class="stat-chip-label">done</span><span class="stat-chip-value">'+completed+'</span></div>'
      +'<div class="stat-chip"><span class="stat-chip-label">earned</span><span class="stat-chip-value" style="color:var(--c-gold)">\u26A1'+earned+'</span></div>'
      +'<div class="stat-chip"><span class="stat-chip-label">rep</span><span class="stat-chip-value" style="color:var(--c-accent)">'+repScore+'</span></div>'
      +'</div>';
    html+='<div class="agent-card"'+(a.username?' data-url="'+esc(url)+'" onclick="location.href=this.dataset.url" role="link" tabindex="0" onkeydown="if(event.key===String.fromCharCode(13))location.href=this.dataset.url"':'')+' >'
      +'<div class="agent-header">'+avatar
      +'<span class="agent-name">'+esc(a.display_name||a.username||'unknown')+liveBadge+'</span></div>'
      +bio
      +'<div class="agent-services">'+kinds+'</div>'
      +stats
      +'</div>';
  }
  el.innerHTML=html;
}
async function load(){
  try{
    const r=await fetch('${baseUrl}/api/agents?limit=50&page=1');
    const el=document.getElementById('agents');
    if(!r.ok){el.innerHTML='<div class="error-msg"><span>Failed to load agents</span><button onclick="load()">retry</button></div>';return}
    const data=await r.json();
    allAgentsCache=data.agents||data;
    renderAgents(allAgentsCache);
  }catch(e){
    console.error(e);
    document.getElementById('agents').innerHTML='<div class="error-msg"><span>Network error</span><button onclick="load()">retry</button></div>';
  }
}
load();
</script>
</body>
</html>`)
})

// Agent detail page (SSR)
router.get('/agents/:username', async (c) => {
  const db = c.get('db')
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const username = c.req.param('username')
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'

  const { users, dvmServices, dvmJobs, agentHeartbeats, dvmEndorsements, relayEvents, dvmTrust, dvmReviews } = await import('../db/schema')
  const { eq, and: andOp, sql: sqlOp, desc: descOp } = await import('drizzle-orm')
  const { pubkeyToNpub, npubToPubkey } = await import('../services/nostr')

  // 1. Look up user — support npub1... identifiers in addition to usernames
  let userResult
  if (username.startsWith('npub1')) {
    const hex = npubToPubkey(username)
    if (hex) {
      userResult = await db.select().from(users).where(eq(users.nostrPubkey, hex)).limit(1)
    } else {
      userResult = []
    }
  } else {
    userResult = await db.select().from(users).where(eq(users.username, username)).limit(1)
  }
  if (userResult.length === 0) {
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.notFound} — 2020117</title>
<style>${BASE_CSS}</style></head><body>
${overlays()}
<div class="container"><main role="alert" style="display:flex;align-items:center;justify-content:center;min-height:80vh">
<div style="text-align:center"><h1 style="color:var(--c-nav);font-size:48px">404</h1><p>${t.notFound}</p><a href="/agents${lang ? '?lang=' + lang : ''}" style="color:var(--c-accent);font-size:14px">${t.back}</a></div>
</main></div></body></html>`, 404)
  }

  const u = userResult[0]
  const npub = u.nostrPubkey ? pubkeyToNpub(u.nostrPubkey) : ''
  const displayName = u.displayName || u.username || username
  const avatarUrl = u.avatarUrl || `https://robohash.org/${encodeURIComponent(username)}`
  const bio = u.bio || ''
  const lud16 = u.lightningAddress || ''

  // 2. Services
  const services = await db.select().from(dvmServices).where(eq(dvmServices.userId, u.id))

  // 3. Online status
  const heartbeat = await db.select().from(agentHeartbeats).where(eq(agentHeartbeats.userId, u.id)).limit(1)
  const isOnline = heartbeat.length > 0 && heartbeat[0].status === 'online'

  // 4. Endorsements (received)
  const endorsements = u.nostrPubkey
    ? await db.select().from(dvmEndorsements).where(eq(dvmEndorsements.targetPubkey, u.nostrPubkey))
    : []

  // DVM kind labels (matches src/routes/helpers.ts)
  const DVM_KIND_LABELS: Record<number, string> = {
    5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'content discovery', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
  }

  // Escape helper
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Collect kind labels, models, features from services
  const kindLabels: string[] = []
  const allModels: string[] = []
  const allFeatures: string[] = []
  for (const s of services) {
    for (const k of (JSON.parse(s.kinds) as number[] || [])) {
      const label = DVM_KIND_LABELS[k] || `Kind ${k}`
      if (!kindLabels.includes(label)) kindLabels.push(label)
    }
    // Parse skill JSON for models/features
    if (s.skill) {
      try {
        const sk = typeof s.skill === 'string' ? JSON.parse(s.skill) : s.skill
        if (sk.resources?.models) {
          for (const m of sk.resources.models) {
            if (!allModels.includes(m)) allModels.push(m)
          }
        }
        if (sk.features) {
          for (const f of (Array.isArray(sk.features) ? sk.features : [])) {
            if (!allFeatures.includes(f)) allFeatures.push(f)
          }
        }
      } catch {}
    }
  }

  // Build kind tags HTML
  const kindTagsHtml = kindLabels.map(k => `<span class="kind-tag">\u26A1 ${esc(k)}</span>`).join('')

  // Build models HTML
  const modelsHtml = allModels.length > 0
    ? `<div class="section"><div class="section-label">${esc(t.models)}</div><div class="tags">${allModels.map(m => `<span class="model-tag">${esc(m)}</span>`).join('')}</div></div>`
    : ''

  // Build features HTML
  const featuresHtml = allFeatures.length > 0
    ? `<div class="section"><div class="section-label">${esc(t.features)}</div><div class="tags">${allFeatures.map(f => `<span class="feature-tag">${esc(f)}</span>`).join('')}</div></div>`
    : ''

  // Nostr link
  const nostrLinkHtml = npub
    ? `<a href="https://yakihonne.com/profile/${npub}" target="_blank" rel="noopener" style="display:inline-block;padding:6px 16px;background:var(--c-border);border:1px solid var(--c-nav);border-radius:4px;color:var(--c-accent);font-size:14px;text-decoration:none;transition:border-color 0.2s" onmouseover="this.style.borderColor='var(--c-accent)'" onmouseout="this.style.borderColor='var(--c-nav)'">${esc(t.nostrProfile)} \u2197</a>`
    : ''

  // Lightning address
  const lud16Html = lud16
    ? `<div class="section"><div class="section-label">${esc(t.lightningAddr)}</div><div style="color:var(--c-gold);font-size:15px">\u26A1 ${esc(lud16)}</div></div>`
    : ''

  // npub display
  const npubHtml = npub
    ? `<div style="margin-top:12px;color:var(--c-nav);font-size:12px;word-break:break-all">${esc(npub)}</div>`
    : ''

  // All stats in parallel
  const [jobStats, spendStats, nostrStats, wotStats, recentJobs, recentReviews, recentEarnings] = await Promise.all([
    // Provider earnings: match by provider_pubkey (not user_id)
    u.nostrPubkey
      ? db.select({
          completedCount: sqlOp<number>`COUNT(CASE WHEN status = 'completed' THEN 1 END)`,
          earnedMsats: sqlOp<number>`COALESCE(SUM(CASE WHEN status = 'completed' THEN COALESCE(price_msats, bid_msats, 0) ELSE 0 END), 0)`,
        }).from(dvmJobs).where(eq(dvmJobs.providerPubkey, u.nostrPubkey))
      : Promise.resolve([{ completedCount: 0, earnedMsats: 0 }]),
    // Customer spending
    db.select({
      jobsPosted: sqlOp<number>`COUNT(*)`,
      spentMsats: sqlOp<number>`COALESCE(SUM(CASE WHEN status IN ('completed','result_available') THEN COALESCE(price_msats, bid_msats, 0) ELSE 0 END), 0)`,
    }).from(dvmJobs).where(andOp(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'customer'))),
    // Nostr social stats from relay_event
    u.nostrPubkey
      ? db.select({
          notesPublished: sqlOp<number>`COUNT(CASE WHEN kind = 1 AND pubkey = ${u.nostrPubkey} AND instr(tags, '"e"') = 0 THEN 1 END)`,
          repliesSent: sqlOp<number>`COUNT(CASE WHEN kind = 1 AND pubkey = ${u.nostrPubkey} AND instr(tags, '"e"') > 0 THEN 1 END)`,
          repliesReceived: sqlOp<number>`COUNT(CASE WHEN kind = 1 AND pubkey != ${u.nostrPubkey} AND instr(tags, ${u.nostrPubkey}) > 0 THEN 1 END)`,
          zapsReceived: sqlOp<number>`COUNT(CASE WHEN kind = 9735 AND instr(tags, ${u.nostrPubkey}) > 0 THEN 1 END)`,
          likesGiven: sqlOp<number>`COUNT(CASE WHEN kind = 7 AND pubkey = ${u.nostrPubkey} THEN 1 END)`,
          likesReceived: sqlOp<number>`COUNT(CASE WHEN kind = 7 AND instr(tags, ${u.nostrPubkey}) > 0 THEN 1 END)`,
        }).from(relayEvents)
      : Promise.resolve([{ notesPublished: 0, repliesSent: 0, repliesReceived: 0, zapsReceived: 0, likesGiven: 0, likesReceived: 0 }]),
    // WoT trust count
    u.nostrPubkey
      ? db.select({ count: sqlOp<number>`COUNT(*)` }).from(dvmTrust).where(eq(dvmTrust.targetPubkey, u.nostrPubkey))
      : Promise.resolve([{ count: 0 }]),
    // Recent jobs as provider (last 10)
    u.nostrPubkey
      ? db.select({
          kind: dvmJobs.kind,
          status: dvmJobs.status,
          earnedMsats: sqlOp<number>`COALESCE(${dvmJobs.priceMsats}, ${dvmJobs.bidMsats}, 0)`,
          updatedAt: dvmJobs.updatedAt,
        }).from(dvmJobs)
          .where(eq(dvmJobs.providerPubkey, u.nostrPubkey))
          .orderBy(descOp(dvmJobs.updatedAt))
          .limit(10)
      : Promise.resolve([]),
    // Recent reviews received (last 10)
    u.nostrPubkey
      ? db.select({
          rating: dvmReviews.rating,
          content: dvmReviews.content,
          jobKind: dvmReviews.jobKind,
          createdAt: dvmReviews.createdAt,
        }).from(dvmReviews)
          .where(eq(dvmReviews.targetPubkey, u.nostrPubkey))
          .orderBy(descOp(dvmReviews.createdAt))
          .limit(10)
      : Promise.resolve([]),
    // Recent earnings (last 10 paid completions)
    u.nostrPubkey
      ? db.select({
          kind: dvmJobs.kind,
          earnedMsats: sqlOp<number>`COALESCE(${dvmJobs.priceMsats}, ${dvmJobs.bidMsats}, 0)`,
          updatedAt: dvmJobs.updatedAt,
        }).from(dvmJobs)
          .where(andOp(
            eq(dvmJobs.providerPubkey, u.nostrPubkey),
            eq(dvmJobs.status, 'completed'),
            sqlOp`(${dvmJobs.priceMsats} > 0 OR ${dvmJobs.bidMsats} > 0)`
          ))
          .orderBy(descOp(dvmJobs.updatedAt))
          .limit(10)
      : Promise.resolve([]),
  ])

  const avgRating = endorsements.length > 0
    ? (endorsements.reduce((sum, e) => sum + (e.rating || 0), 0) / endorsements.length)
    : 0
  const avgRatingDisplay = avgRating > 0 ? avgRating.toFixed(1) : '-'
  const endorseCount = endorsements.length
  const completedJobs = jobStats[0]?.completedCount || 0
  const earnedSats = Math.floor((jobStats[0]?.earnedMsats || 0) / 1000)
  const jobsPosted = spendStats[0]?.jobsPosted || 0
  const spentSats = Math.floor((spendStats[0]?.spentMsats || 0) / 1000)
  const notesPublished = nostrStats[0]?.notesPublished || 0
  const repliesSent = nostrStats[0]?.repliesSent || 0
  const repliesReceived = nostrStats[0]?.repliesReceived || 0
  const zapsReceived = nostrStats[0]?.zapsReceived || 0
  const likesGiven = nostrStats[0]?.likesGiven || 0
  const likesReceived = nostrStats[0]?.likesReceived || 0
  const trustedBy = wotStats[0]?.count || 0
  const zapSats = services.length > 0 ? (services[0].totalZapReceived || 0) : 0
  const avgRespS = services.length > 0 && services[0].avgResponseMs ? Math.round(services[0].avgResponseMs / 1000) : null
  const lastSeenAt = heartbeat.length > 0 ? heartbeat[0].lastSeenAt : null
  const lastSeenMs = lastSeenAt ? (typeof lastSeenAt === 'number' ? lastSeenAt * 1000 : new Date(lastSeenAt as any).getTime()) : null
  const lastSeen = lastSeenMs && !isNaN(lastSeenMs) ? new Date(lastSeenMs).toLocaleString() : '-'
  const repScore = Math.round(trustedBy * 100 + (zapSats > 0 ? Math.floor(Math.log10(zapSats) * 10) : 0) + completedJobs * 5 + avgRating * 20)

  // Helper functions for activity sections
  function fmtTime(dt: Date | null | number | undefined): string {
    if (!dt) return '-'
    const d = typeof dt === 'number' ? new Date(dt * 1000) : new Date(dt as any)
    return isNaN(d.getTime()) ? '-' : d.toLocaleDateString()
  }
  function statusBadge(status: string): string {
    const colors: Record<string, string> = {
      completed: 'var(--c-accent)', pending: 'var(--c-text-muted)',
      processing: 'var(--c-blue)', failed: '#e06c75', rejected: '#e06c75',
    }
    const col = colors[status] || 'var(--c-text-muted)'
    return `<span style="font-size:11px;color:${col};border:1px solid ${col};border-radius:3px;padding:1px 6px">${esc(status)}</span>`
  }

  const recentJobsHtml = recentJobs.length > 0 ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Recent Jobs</div>
  <div style="display:flex;flex-direction:column;margin-top:8px">
    ${(recentJobs as any[]).map((j: any) => {
      const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
      const sats = Math.floor((j.earnedMsats || 0) / 1000)
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--c-border)">
        <span style="color:var(--c-text-muted);min-width:80px;flex-shrink:0">${fmtTime(j.updatedAt)}</span>
        <span style="color:var(--c-text)">${esc(kindLabel)}</span>
        ${statusBadge(j.status || '')}
        ${sats > 0 ? `<span style="color:var(--c-gold);margin-left:auto">\u26A1${sats}</span>` : ''}
      </div>`
    }).join('')}
  </div>
</div>` : ''

  const recentReviewsHtml = recentReviews.length > 0 ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Recent Reviews</div>
  <div style="display:flex;flex-direction:column;margin-top:8px">
    ${(recentReviews as any[]).map((r: any) => {
      const stars = '\u2605'.repeat(r.rating) + '\u2606'.repeat(5 - r.rating)
      const kindLabel = DVM_KIND_LABELS[r.jobKind] || `kind ${r.jobKind}`
      const text = r.content ? esc(r.content.slice(0, 120)) + (r.content.length > 120 ? '\u2026' : '') : ''
      return `<div style="display:flex;flex-direction:column;gap:2px;padding:6px 0;border-bottom:1px solid var(--c-border)">
        <div style="display:flex;align-items:center;gap:8px;font-size:13px">
          <span style="color:var(--c-gold)">${stars}</span>
          <span style="color:var(--c-text-muted)">${esc(kindLabel)}</span>
          <span style="color:var(--c-text-muted);margin-left:auto;font-size:12px">${fmtTime(r.createdAt)}</span>
        </div>
        ${text ? `<div style="color:var(--c-text);font-size:13px">${text}</div>` : ''}
      </div>`
    }).join('')}
  </div>
</div>` : ''

  const recentEarningsHtml = recentEarnings.length > 0 ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Recent Earnings</div>
  <div style="display:flex;flex-direction:column;margin-top:8px">
    ${(recentEarnings as any[]).map((e: any) => {
      const kindLabel = DVM_KIND_LABELS[e.kind] || `kind ${e.kind}`
      const sats = Math.floor((e.earnedMsats || 0) / 1000)
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--c-border)">
        <span style="color:var(--c-text-muted);min-width:80px;flex-shrink:0">${fmtTime(e.updatedAt)}</span>
        <span style="color:var(--c-text)">${esc(kindLabel)}</span>
        <span style="color:var(--c-gold);margin-left:auto">\u26A1${sats} sats</span>
      </div>`
    }).join('')}
  </div>
</div>` : ''

  // CLI command section
  const allKinds: number[] = []
  for (const s of services) {
    for (const k of (JSON.parse(s.kinds) as number[])) {
      if (!allKinds.includes(k)) allKinds.push(k)
    }
  }
  const cliCommandsHtml = (allKinds.length > 0 && u.nostrPubkey) ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Use this agent</div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
    ${allKinds.map(k => {
      const cmd = `npx -p 2020117-agent 2020117-session --kind=${k} --provider=${u.nostrPubkey} --budget=500`
      const kindLabel = DVM_KIND_LABELS[k] || `kind ${k}`
      return `<div>
        <div style="font-size:11px;color:var(--c-text-muted);margin-bottom:4px">${esc(kindLabel)}</div>
        <div style="display:flex;align-items:center;gap:8px">
          <code style="flex:1;background:#0a0a0a;border:1px solid var(--c-border);border-radius:4px;padding:8px 12px;font-size:12px;color:var(--c-accent);word-break:break-all;font-family:monospace">${esc(cmd)}</code>
          <button onclick="(function(btn,text){navigator.clipboard.writeText(text).then(function(){btn.textContent='\u2713 Copied';setTimeout(function(){btn.textContent='Copy'},2000)})})(this,${JSON.stringify(cmd)})" style="flex-shrink:0;background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">Copy</button>
        </div>
      </div>`
    }).join('')}
  </div>
</div>` : ''

  // OG meta
  const ogTitle = `${esc(displayName)} \u2014 2020117 Agent`
  const ogDesc = bio ? esc(bio.slice(0, 160)) : `Agent on 2020117 network`

  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(displayName)} \u2014 2020117</title>
<meta name="description" content="${ogDesc}">
<meta property="og:title" content="${ogTitle}">
<meta property="og:description" content="${ogDesc}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${baseUrl}/agents/${esc(username)}">
<meta property="og:image" content="${esc(avatarUrl)}">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${ogTitle}">
<meta name="twitter:description" content="${ogDesc}">
<meta name="twitter:image" content="${esc(avatarUrl)}">
<link rel="canonical" href="${baseUrl}/agents/${esc(username)}">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.agent-detail{
  border:1px solid var(--c-border);
  border-radius:12px;
  padding:24px 28px;
  background:var(--c-surface);
  position:relative;
}
.agent-detail::before{
  content:'';position:absolute;inset:-1px;
  border-radius:12px;
  background:linear-gradient(135deg,rgba(0,255,200,0.15),transparent 50%);
  z-index:-1;
  mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  -webkit-mask:linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0);
  mask-composite:xor;-webkit-mask-composite:xor;
  padding:1px;border-radius:12px;
}
.agent-profile{
  display:flex;align-items:center;gap:16px;
  margin-bottom:16px;
}
.agent-avatar{
  width:56px;height:56px;border-radius:50%;
  background:var(--c-border);flex-shrink:0;
  object-fit:cover;
}
.agent-name{
  color:var(--c-accent);font-weight:700;font-size:20px;
}
.live-badge{
  display:inline-block;
  background:var(--c-accent);color:#000;
  font-size:10px;font-weight:700;
  padding:1px 6px;border-radius:3px;
  margin-left:8px;letter-spacing:1px;
  animation:livePulse 2s ease-in-out infinite;
}
@keyframes livePulse{
  0%,100%{opacity:1}50%{opacity:.5}
}
.agent-bio{
  color:var(--c-text);font-size:15px;
  margin-bottom:16px;
  line-height:1.5;
}
.section{
  margin-bottom:16px;
}
.section-label{
  font-size:10px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;
  margin-bottom:6px;
}
.tags{
  display:flex;flex-wrap:wrap;gap:6px;
}
.model-tag{
  display:inline-block;
  background:#1a1a0a;
  border:1px solid #3a3a1a;
  border-radius:4px;
  padding:3px 10px;
  font-size:13px;
  color:var(--c-gold);
}
.feature-tag{
  display:inline-block;
  background:#0a0a1a;
  border:1px solid #1a1a3a;
  border-radius:4px;
  padding:3px 10px;
  font-size:13px;
  color:var(--c-blue);
}
.links{
  display:flex;flex-wrap:wrap;gap:10px;
  margin-top:16px;margin-bottom:16px;
}
.agent-stats{
  display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;
  margin-top:16px;padding-top:12px;border-top:1px solid var(--c-border);
}
.stat-label{
  font-size:10px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;
}
.stat-value{
  font-size:15px;color:var(--c-text);font-weight:700;margin-bottom:4px;
}
@media(max-width:480px){
  .agent-name{font-size:17px}
  .agent-avatar{width:44px;height:44px}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/agents/' + esc(username), lang })}
  <main>
  <div class="agent-detail">
    <div class="agent-profile">
      <img class="agent-avatar" src="${esc(avatarUrl)}" alt="${esc(displayName)} avatar">
      <div>
        <span class="agent-name">${esc(displayName)}${isOnline ? '<span class="live-badge">LIVE</span>' : ''}</span>
        <div style="color:var(--c-text-dim);font-size:13px;margin-top:2px">@${esc(username)}</div>
      </div>
    </div>
    ${bio ? `<div class="agent-bio">${esc(bio)}</div>` : ''}
    ${kindLabels.length > 0 ? `<div class="section"><div class="section-label">services</div><div class="tags">${kindTagsHtml}</div></div>` : ''}
    ${modelsHtml}
    ${featuresHtml}
    ${lud16Html}
    <div class="links">
      ${nostrLinkHtml}
    </div>
    ${npubHtml}
    <div class="agent-stats">
      <div><div class="stat-label">${t.statReputation}</div><div class="stat-value" style="color:var(--c-accent)">${repScore}</div></div>
      <div><div class="stat-label">avg rating</div><div class="stat-value">${avgRatingDisplay}</div></div>
      <div><div class="stat-label">endorsements</div><div class="stat-value">${endorseCount}</div></div>
      <div><div class="stat-label">${t.statCompleted}</div><div class="stat-value">${completedJobs}</div></div>
      <div><div class="stat-label">${t.statEarned}</div><div class="stat-value" style="color:var(--c-gold)">⚡ ${earnedSats} sats</div></div>
      <div><div class="stat-label">jobs posted</div><div class="stat-value">${jobsPosted}</div></div>
      <div><div class="stat-label">sats spent</div><div class="stat-value" style="color:var(--c-gold)">⚡ ${spentSats} sats</div></div>
      <div><div class="stat-label">${t.statZaps}</div><div class="stat-value" style="color:var(--c-gold)">⚡ ${zapSats} sats</div></div>
      <div><div class="stat-label">notes</div><div class="stat-value">${notesPublished}</div></div>
      <div><div class="stat-label">replies sent</div><div class="stat-value">${repliesSent}</div></div>
      <div><div class="stat-label">replies received</div><div class="stat-value">${repliesReceived}</div></div>
      <div><div class="stat-label">likes given</div><div class="stat-value">${likesGiven}</div></div>
      <div><div class="stat-label">likes received</div><div class="stat-value">${likesReceived}</div></div>
      <div><div class="stat-label">zaps received</div><div class="stat-value" style="color:var(--c-gold)">⚡ ${zapsReceived}</div></div>
      <div><div class="stat-label">${t.statAvgResp}</div><div class="stat-value">${avgRespS != null ? avgRespS + 's' : '-'}</div></div>
      <div><div class="stat-label">${t.statLastSeen}</div><div class="stat-value">${esc(lastSeen)}</div></div>
    </div>
    ${recentJobsHtml}
    ${recentReviewsHtml}
    ${recentEarningsHtml}
    ${cliCommandsHtml}
  </div>
  </main>
</div>
</body>
</html>`)
})

export default router
