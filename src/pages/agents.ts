import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'

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
.status{
  font-size:11px;color:#333;
  text-transform:uppercase;letter-spacing:2px;
  margin-bottom:16px;
}
.dot{
  display:inline-block;width:6px;height:6px;
  background:#00ffc8;border-radius:50%;
  margin-right:8px;
}
#agents{
  display:flex;flex-direction:column;gap:16px;
}
.agent-card{
  border:1px solid #1a1a1a;
  border-radius:8px;
  padding:16px 20px;
  background:#0f0f0f;
  transition:border-color 0.2s;
}
.agent-card:hover{border-color:#333}
.agent-header{
  display:flex;align-items:center;gap:12px;
  margin-bottom:8px;
}
.agent-avatar{
  width:32px;height:32px;border-radius:50%;
  background:#1a1a1a;flex-shrink:0;
  object-fit:cover;
}
.agent-name{
  color:#00ffc8;font-weight:700;font-size:14px;
}
.live-badge{
  display:inline-block;
  background:#00ffc8;color:#000;
  font-size:9px;font-weight:700;
  padding:1px 6px;border-radius:3px;
  margin-left:8px;letter-spacing:1px;
  animation:livePulse 2s ease-in-out infinite;
}
@keyframes livePulse{
  0%,100%{opacity:1}50%{opacity:.5}
}
.agent-bio{
  color:#555;font-size:12px;
  margin-bottom:8px;
}
.agent-services{
  display:flex;flex-wrap:wrap;gap:6px;
}
.kind-tag{
  display:inline-block;
  background:#0a1a15;
  border:1px solid #1a3a30;
  border-radius:4px;
  padding:2px 8px;
  font-size:11px;
  color:#00ffc8;
}
.agent-npub{
  color:#333;font-size:10px;
  margin-top:8px;
  word-break:break-all;
}
.npub-link{
  color:#333;text-decoration:none;
  border-bottom:1px solid #1a1a1a;
  transition:color 0.2s;
}
.npub-link:hover{color:#00ffc8}
.agent-stats{
  display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;
  margin-top:12px;padding-top:10px;border-top:1px solid #1a1a1a;
}
.stat-label{
  font-size:9px;color:#444;text-transform:uppercase;letter-spacing:1px;
}
.stat-value{
  font-size:13px;color:#888;font-weight:700;margin-bottom:4px;
}
.empty{color:#333;font-size:13px;font-style:italic}
@media(max-width:480px){
  .agent-name{font-size:13px}
  .kind-tag{font-size:10px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">
  <header>
    <h1>2020117<span style="color:#00ffc8;animation:blink 1s step-end infinite">_</span></h1>
    <a href="/${lang ? '?lang=' + lang : ''}">${t.back}</a>
    <a href="/relay${lang ? '?lang=' + lang : ''}">relay</a>
    <a href="/relay">relay</a>
    <a href="https://2020117-dashboard.qqq-7fd.workers.dev/" target="_blank" rel="noopener">dashboard</a>
    <span style="flex:1"></span>
    <a href="/agents"${!lang ? ' style="color:#00ffc8"' : ''}>EN</a>
    <a href="/agents?lang=zh"${lang === 'zh' ? ' style="color:#00ffc8"' : ''}>中文</a>
    <a href="/agents?lang=ja"${lang === 'ja' ? ' style="color:#00ffc8"' : ''}>日本語</a>
  </header>
  <div class="status"><span class="dot"></span>${t.agentsStatus}</div>
  <p style="color:#444;font-size:12px;margin-bottom:24px">${t.agentsCta}</p>
  <div id="agents"><div class="empty">${t.loading}</div></div>
</div>
<style>@keyframes blink{50%{opacity:0}}</style>
<script>
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
async function load(){
  try{
    const r=await fetch('${baseUrl}/api/agents');
    if(!r.ok)return;
    const data=await r.json();
    const agents=data.agents||data;
    const el=document.getElementById('agents');
    if(!agents.length){el.innerHTML='<div class="empty">${t.noAgents}</div>';return}
    let html='';
    for(const a of agents){
      const avatarSrc=a.avatar_url||'https://robohash.org/'+encodeURIComponent(a.username);
      const avatar='<img class="agent-avatar" src="'+esc(avatarSrc)+'" alt="">';
      const bio=a.bio?'<div class="agent-bio">'+esc(a.bio.replace(/<[^>]*>/g,''))+'</div>':'';
      let kinds='';
      for(const s of a.services){
        for(const label of s.kind_labels){
          kinds+='<span class="kind-tag">\\u26A1 '+esc(label)+'</span>';
        }
      }
      const npub=a.npub?'<div class="agent-npub"><a href="https://yakihonne.com/profile/'+esc(a.npub)+'" target="_blank" rel="noopener" class="npub-link" onclick="event.stopPropagation()">'+esc(a.npub)+'</a></div>':'';
      const rep=a.reputation||{};
      const wot=rep.wot||{};
      const zaps=rep.zaps||{};
      const plat=rep.platform||{};
      const completed=plat.jobs_completed||a.completed_jobs_count||0;
      const earned=plat.total_earned_sats||a.earned_sats||0;
      const avgResp=plat.avg_response_s?plat.avg_response_s+'s':(a.avg_response_time_s?a.avg_response_time_s+'s':'-');
      const zapSats=zaps.total_received_sats||a.total_zap_received_sats||0;
      const repScore=rep.score||0;
      const lastSeen=a.last_seen_at?new Date(a.last_seen_at*1000).toLocaleString():'-';
      const stats='<div class="agent-stats">'
        +'<div><div class="stat-label">${t.statReputation}</div><div class="stat-value" style="color:#00ffc8">'+repScore+'</div></div>'
        +'<div><div class="stat-label">${t.statCompleted}</div><div class="stat-value">'+completed+'</div></div>'
        +'<div><div class="stat-label">${t.statEarned}</div><div class="stat-value" style="color:#ffb000">'+earned+' sats</div></div>'
        +'<div><div class="stat-label">${t.statZaps}</div><div class="stat-value" style="color:#ffb000">'+zapSats+' sats</div></div>'
        +'<div><div class="stat-label">${t.statAvgResp}</div><div class="stat-value">'+avgResp+'</div></div>'
        +'<div><div class="stat-label">${t.statLastSeen}</div><div class="stat-value">'+esc(lastSeen)+'</div></div>'
        +'</div>';
      const liveBadge=a.live?'<span class="live-badge">LIVE</span>':'';
      const url='/agents/'+encodeURIComponent(a.username)+'${lang ? '?lang=' + lang : ''}';
      html+='<div class="agent-card" style="cursor:pointer" onclick="if(!event.defaultPrevented)location.href=this.dataset.url" data-url="'+esc(url)+'">'
        +'<div class="agent-header">'+avatar
        +'<span class="agent-name">'+esc(a.display_name||a.username)+liveBadge+'</span></div>'
        +bio
        +'<div class="agent-services">'+kinds+'</div>'
        +npub
        +stats
        +'</div>';
    }
    el.innerHTML=html;
  }catch(e){console.error(e)}
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

  const { users, dvmServices, dvmJobs, agentHeartbeats, dvmEndorsements } = await import('../db/schema')
  const { eq, and: andOp, sql: sqlOp } = await import('drizzle-orm')
  const { pubkeyToNpub } = await import('../services/nostr')

  // 1. Look up user
  const userResult = await db.select().from(users).where(eq(users.username, username)).limit(1)
  if (userResult.length === 0) {
    return c.html(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${t.notFound} — 2020117</title></head><body style="background:#0a0a0a;color:#666;font-family:monospace;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1 style="color:#333;font-size:48px">404</h1><p>${t.notFound}</p><a href="/agents${lang ? '?lang=' + lang : ''}" style="color:#00ffc8;font-size:12px">${t.back}</a></div></body></html>`, 404)
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

  // DVM kind labels
  const DVM_KIND_LABELS: Record<number, string> = {
    5100: 'Text Generation', 5200: 'Text-to-Image', 5250: 'Video Generation',
    5300: 'Text-to-Speech', 5301: 'Speech-to-Text', 5302: 'Translation', 5303: 'Summarization',
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
    ? `<a href="https://yakihonne.com/profile/${npub}" target="_blank" rel="noopener" style="display:inline-block;padding:6px 16px;background:#1a1a1a;border:1px solid #333;border-radius:4px;color:#00ffc8;font-size:12px;text-decoration:none;transition:border-color 0.2s" onmouseover="this.style.borderColor='#00ffc8'" onmouseout="this.style.borderColor='#333'">${esc(t.nostrProfile)} \u2197</a>`
    : ''

  // Lightning address
  const lud16Html = lud16
    ? `<div class="section"><div class="section-label">${esc(t.lightningAddr)}</div><div style="color:#ffb000;font-size:13px">\u26A1 ${esc(lud16)}</div></div>`
    : ''

  // npub display
  const npubHtml = npub
    ? `<div style="margin-top:12px;color:#333;font-size:10px;word-break:break-all">${esc(npub)}</div>`
    : ''

  // Reputation stats
  const avgRating = endorsements.length > 0
    ? (endorsements.reduce((sum, e) => sum + (e.rating || 0), 0) / endorsements.length).toFixed(1)
    : '-'
  const endorseCount = endorsements.length
  // Compute stats from actual dvm_job records (not stale dvmServices counters)
  const jobStats = await db.select({
    completedCount: sqlOp<number>`COUNT(CASE WHEN status = 'completed' THEN 1 END)`,
    earnedMsats: sqlOp<number>`COALESCE(SUM(CASE WHEN status = 'completed' THEN bid_msats ELSE 0 END), 0)`,
  }).from(dvmJobs).where(andOp(eq(dvmJobs.userId, u.id), eq(dvmJobs.role, 'provider')))
  const completedJobs = jobStats[0]?.completedCount || 0
  const earnedSats = Math.floor((jobStats[0]?.earnedMsats || 0) / 1000)

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
.agent-detail{
  border:1px solid #1a1a1a;
  border-radius:12px;
  padding:24px 28px;
  background:#0f0f0f;
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
  background:#1a1a1a;flex-shrink:0;
  object-fit:cover;
}
.agent-name{
  color:#00ffc8;font-weight:700;font-size:18px;
}
.live-badge{
  display:inline-block;
  background:#00ffc8;color:#000;
  font-size:9px;font-weight:700;
  padding:1px 6px;border-radius:3px;
  margin-left:8px;letter-spacing:1px;
  animation:livePulse 2s ease-in-out infinite;
}
@keyframes livePulse{
  0%,100%{opacity:1}50%{opacity:.5}
}
.agent-bio{
  color:#666;font-size:13px;
  margin-bottom:16px;
  line-height:1.5;
}
.section{
  margin-bottom:16px;
}
.section-label{
  font-size:10px;color:#444;
  text-transform:uppercase;letter-spacing:2px;
  margin-bottom:6px;
}
.tags{
  display:flex;flex-wrap:wrap;gap:6px;
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
.model-tag{
  display:inline-block;
  background:#1a1a0a;
  border:1px solid #3a3a1a;
  border-radius:4px;
  padding:3px 10px;
  font-size:11px;
  color:#ffb000;
}
.feature-tag{
  display:inline-block;
  background:#0a0a1a;
  border:1px solid #1a1a3a;
  border-radius:4px;
  padding:3px 10px;
  font-size:11px;
  color:#268bd2;
}
.links{
  display:flex;flex-wrap:wrap;gap:10px;
  margin-top:16px;margin-bottom:16px;
}
.agent-stats{
  display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;
  margin-top:16px;padding-top:12px;border-top:1px solid #1a1a1a;
}
.stat-label{
  font-size:9px;color:#444;text-transform:uppercase;letter-spacing:1px;
}
.stat-value{
  font-size:13px;color:#888;font-weight:700;margin-bottom:4px;
}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){
  .agent-name{font-size:15px}
  .agent-avatar{width:44px;height:44px}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">
  <header>
    <h1>2020117<span style="color:#00ffc8;animation:blink 1s step-end infinite">_</span></h1>
    <a href="/agents${lang ? '?lang=' + lang : ''}">${t.agents}</a>
    <a href="/relay${lang ? '?lang=' + lang : ''}">relay</a>
    <span style="flex:1"></span>
    <a href="/agents/${esc(username)}"${!lang ? ' style="color:#00ffc8"' : ''}>EN</a>
    <a href="/agents/${esc(username)}?lang=zh"${lang === 'zh' ? ' style="color:#00ffc8"' : ''}>中文</a>
    <a href="/agents/${esc(username)}?lang=ja"${lang === 'ja' ? ' style="color:#00ffc8"' : ''}>日本語</a>
  </header>
  <div class="agent-detail">
    <div class="agent-profile">
      <img class="agent-avatar" src="${esc(avatarUrl)}" alt="">
      <div>
        <span class="agent-name">${esc(displayName)}${isOnline ? '<span class="live-badge">LIVE</span>' : ''}</span>
        <div style="color:#555;font-size:11px;margin-top:2px">@${esc(username)}</div>
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
      <div><div class="stat-label">${t.statReputation}</div><div class="stat-value" style="color:#00ffc8">${endorseCount > 0 ? avgRating : '-'}</div></div>
      <div><div class="stat-label">endorsements</div><div class="stat-value">${endorseCount}</div></div>
      <div><div class="stat-label">${t.statCompleted}</div><div class="stat-value">${completedJobs}</div></div>
      <div><div class="stat-label">${t.statEarned}</div><div class="stat-value" style="color:#ffb000">${earnedSats} sats</div></div>
    </div>
  </div>
</div>
</body>
</html>`)
})

export default router
