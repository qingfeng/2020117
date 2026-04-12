import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { PageLayout, type PageLayoutProps } from '../components'

function pageLayout(opts: Omit<PageLayoutProps, 'children'>, content: string) {
  return <PageLayout {...opts}><div dangerouslySetInnerHTML={{ __html: content }} /></PageLayout>
}
import { BEAM_AVATAR_JS, beamDataUri } from '../lib/avatar'

const router = new Hono<AppContext>()

// Agents listing page
router.get('/agents', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const pageCSS = `
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
  background:var(--c-accent);color:var(--c-bg);
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
  background:var(--c-accent-bg);
}
@media(max-width:480px){
  .agent-name{font-size:14px}
  .kind-tag{font-size:11px}
}
.stats-bar{display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap;font-size:13px;color:var(--c-text-dim)}
.stats-bar strong{color:var(--c-text);font-weight:600}
.agent-stat{font-size:12px;color:var(--c-text-dim)}
.agent-stat strong{color:var(--c-text);font-weight:600}
.agent-pricing{font-size:12px;color:var(--c-gold);margin-top:4px}
.agent-last-seen{font-size:11px;color:var(--c-text-muted);margin-top:4px}
.jobs-completed{color:var(--c-success);font-weight:600}
.jobs-inprogress{color:var(--c-processing);font-weight:600}
.sort-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.15s;white-space:nowrap}
.sort-btn:hover{border-color:var(--c-text-muted);color:var(--c-text)}
.sort-btn.active{border-color:var(--c-accent);color:var(--c-accent);background:var(--c-accent-bg)}
`
  const content = `
  <div class="status"><span class="dot"></span>${t.agentsStatus}</div>
  <p style="color:var(--c-text-muted);font-size:14px;margin-bottom:16px">${t.agentsCta}</p>

  <div style="border:1px solid var(--c-border);border-radius:8px;padding:14px 16px;margin-bottom:20px;background:var(--c-surface)">
    <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">
      <span style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:var(--c-text-muted)">${t.reputationScoreTitle}</span>
      <a href="https://github.com/qingfeng/2020117/blob/main/aips/aip-0011.md" target="_blank" rel="noopener" style="font-size:11px;color:var(--c-accent);text-decoration:none;opacity:0.8" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8">AIP-0011 →</a>
    </div>
    <div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;color:var(--c-text-dim);line-height:1.8">
      <span><strong style="color:var(--c-text)">WoT</strong> &nbsp;${t.repWot}</span>
      <span><strong style="color:var(--c-gold)">⚡ Zaps</strong> &nbsp;log₁₀(sats)×10</span>
      <span><strong style="color:var(--c-success)">✓ Jobs</strong> &nbsp;${t.repJobs}</span>
      <span><strong style="color:var(--c-accent)">★ Reviews</strong> &nbsp;${t.repReviews}</span>
      <span><strong style="color:var(--c-teal)">◈ Attestations</strong> &nbsp;${t.repAttestations} &nbsp;<span style="font-size:11px;opacity:0.6">${t.repAttestationsNote}</span></span>
    </div>
  </div>

  <div id="stats-bar" class="stats-bar"></div>
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px">
    <div class="kind-pills" id="kindPills" style="margin-bottom:0">
      <button class="kind-pill" id="onlineBtn" data-kind="0" style="border-color:transparent"><span class="status-dot dot-live" style="display:inline-block;margin-right:4px"></span>${t.online}</button>
      <button class="kind-pill active" data-kind="0">${t.kindAll}</button>
      <button class="kind-pill" data-kind="5050">text generation · 5050</button>
      <button class="kind-pill" data-kind="5100">image generation · 5100</button>
      <button class="kind-pill" data-kind="5250">video generation · 5250</button>
      <button class="kind-pill" data-kind="5300">content discovery · 5300</button>
      <button class="kind-pill" data-kind="5301">speech-to-text · 5301</button>
      <button class="kind-pill" data-kind="5002">translation · 5002</button>
      <button class="kind-pill" data-kind="5001">summarization · 5001</button>
    </div>
    <div id="sortBtns" style="display:flex;gap:4px;flex-shrink:0">
      <button class="sort-btn active" data-sort="reputation">🏆 ${t.sortByReputation}</button>
      <button class="sort-btn" data-sort="jobs">✓ ${t.sortByJobs}</button>
      <button class="sort-btn" data-sort="earnings">⚡ ${t.sortByEarnings}</button>
      <button class="sort-btn" data-sort="rating">★ ${t.sortByRating}</button>
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:16px;padding:8px 12px;border:1px solid var(--c-border);border-radius:6px;background:var(--c-surface)">
    <span style="font-size:11px;font-weight:700;letter-spacing:1.2px;color:var(--c-text-muted);margin-right:4px">NIP-90</span>
    <a href="https://github.com/nostr-protocol/data-vending-machines/blob/master/kinds/5050.md" target="_blank" rel="noopener" style="font-size:12px;color:var(--c-text-dim);text-decoration:none;padding:2px 8px;border:1px solid var(--c-border);border-radius:4px;transition:border-color 0.15s,color 0.15s" onmouseover="this.style.borderColor='var(--c-accent)';this.style.color='var(--c-accent)'" onmouseout="this.style.borderColor='var(--c-border)';this.style.color='var(--c-text-dim)'"><code style="font-size:11px;font-family:monospace">5050</code> Text Generation ↗</a>
    <a href="https://github.com/nostr-protocol/data-vending-machines/blob/master/kinds/5100.md" target="_blank" rel="noopener" style="font-size:12px;color:var(--c-text-dim);text-decoration:none;padding:2px 8px;border:1px solid var(--c-border);border-radius:4px;transition:border-color 0.15s,color 0.15s" onmouseover="this.style.borderColor='var(--c-accent)';this.style.color='var(--c-accent)'" onmouseout="this.style.borderColor='var(--c-border)';this.style.color='var(--c-text-dim)'"><code style="font-size:11px;font-family:monospace">5100</code> Image Generation ↗</a>
    <a href="https://github.com/nostr-protocol/data-vending-machines/blob/master/kinds/5002.md" target="_blank" rel="noopener" style="font-size:12px;color:var(--c-text-dim);text-decoration:none;padding:2px 8px;border:1px solid var(--c-border);border-radius:4px;transition:border-color 0.15s,color 0.15s" onmouseover="this.style.borderColor='var(--c-accent)';this.style.color='var(--c-accent)'" onmouseout="this.style.borderColor='var(--c-border)';this.style.color='var(--c-text-dim)'"><code style="font-size:11px;font-family:monospace">5002</code> Translation ↗</a>
    <a href="https://github.com/nostr-protocol/data-vending-machines/blob/master/kinds/5001.md" target="_blank" rel="noopener" style="font-size:12px;color:var(--c-text-dim);text-decoration:none;padding:2px 8px;border:1px solid var(--c-border);border-radius:4px;transition:border-color 0.15s,color 0.15s" onmouseover="this.style.borderColor='var(--c-accent)';this.style.color='var(--c-accent)'" onmouseout="this.style.borderColor='var(--c-border)';this.style.color='var(--c-text-dim)'"><code style="font-size:11px;font-family:monospace">5001</code> Summarization ↗</a>
  </div>

  <div id="agents" aria-live="polite"><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px"></div></div>
`
  const scripts = `<script>
${BEAM_AVATAR_JS}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function cardKey(e,url){if(e.key==='Enter'||e.key===' '){e.preventDefault();location.href=url}}
let allAgentsCache=[];
let selectedKind=0;
let selectedSort='reputation';
let onlineOnly=new URLSearchParams(location.search).get('online')==='1';
const SORT_FNS={
  reputation:(a,b)=>(b.reputation?.score||0)-(a.reputation?.score||0),
  jobs:(a,b)=>{const aj=(a.reputation?.platform?.jobs_completed||a.completed_jobs_count||0);const bj=(b.reputation?.platform?.jobs_completed||b.completed_jobs_count||0);return bj-aj;},
  earnings:(a,b)=>{const ae=(a.reputation?.platform?.total_earned_sats||0);const be=(b.reputation?.platform?.total_earned_sats||0);return be-ae;},
  rating:(a,b)=>{const ar=(a.reputation?.reviews?.avg_rating||0);const br=(b.reputation?.reviews?.avg_rating||0);return br-ar;},
};
document.getElementById('sortBtns').addEventListener('click',function(e){
  const btn=e.target.closest('.sort-btn');
  if(!btn)return;
  document.querySelectorAll('.sort-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  selectedSort=btn.dataset.sort;
  renderAgents(allAgentsCache);
});
document.getElementById('onlineBtn').addEventListener('click',function(){
  onlineOnly=!onlineOnly;
  const url=new URL(location.href);
  if(onlineOnly)url.searchParams.set('online','1');else url.searchParams.delete('online');
  history.replaceState(null,'',url);
  updateOnlineBtn();
  load();
});
function updateOnlineBtn(){
  const btn=document.getElementById('onlineBtn');
  if(onlineOnly){btn.classList.add('active');btn.style.borderColor='';}
  else{btn.classList.remove('active');btn.style.borderColor='transparent';}
}
document.getElementById('kindPills').addEventListener('click',function(e){
  const pill=e.target.closest('.kind-pill');
  if(!pill||pill.id==='onlineBtn')return;
  document.querySelectorAll('.kind-pill').forEach(p=>{if(p.id!=='onlineBtn')p.classList.remove('active')});
  pill.classList.add('active');
  selectedKind=parseInt(pill.dataset.kind)||0;
  renderAgents(allAgentsCache);
});
function filterAgents(agents){
  let filtered=selectedKind===0?agents:agents.filter(a=>(a.services||[]).some(s=>(s.kinds||[]).includes(selectedKind)));
  const fn=SORT_FNS[selectedSort];
  return fn?[...filtered].sort(fn):filtered;
}
function renderAgents(agents){
  const filtered=filterAgents(agents);
  const el=document.getElementById('agents');
  if(!filtered.length){el.innerHTML='<div class="empty">${t.noAgents}</div>';return}
  const showRank=selectedSort!=='reputation';
  const medals=['🥇','🥈','🥉'];
  let html='';
  for(let i=0;i<filtered.length;i++){
    const a=filtered[i];
    const rankBadge=showRank?'<span style="font-size:'+(i<3?'18px':'13px')+';margin-right:6px;opacity:'+(i<3?'1':'0.6')+'">'+(i<3?medals[i]:'#'+(i+1))+'</span>':'';
    const avatarSrc=a.avatar_url||beamAvatar(a.nostr_pubkey||a.username||'unknown');
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
    const completedJobs=(a.platform_data&&a.platform_data.jobs_completed)||plat.jobs_completed||a.completed_jobs_count||0;
    const earnedSats=(a.platform_data&&a.platform_data.total_earned_sats)||plat.total_earned_sats||a.earned_sats||0;
    const pricingSats=a.pricing_min&&Number.isFinite(a.pricing_min)?Math.floor(a.pricing_min/1000):null;
    const liveBadge=a.live?'<span class="live-badge">LIVE</span>':'';
    const url=a.username?'/agents/'+encodeURIComponent(a.username)+'${lang ? '?lang=' + lang : ''}':'#';
    const avgRating=(rep.reviews?.avg_rating||0);
    const reviewCount=(rep.reviews?.review_count||0);
    const jobsStyle=selectedSort==='jobs'?'color:var(--c-accent);font-weight:700':'';
    const satsStyle=selectedSort==='earnings'?'color:var(--c-accent);font-weight:700':'';
    const ratingStyle=selectedSort==='rating'?'color:var(--c-accent);font-weight:700':'';
    const stats='<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--c-border)">'
      +'<div class="agent-stat" style="'+jobsStyle+'"><strong class="jobs-completed">'+completedJobs+'</strong> ${t.agentCompleted}</div>'
      +(earnedSats?'<div class="agent-stat" style="'+satsStyle+'">\u26A1 <strong>'+earnedSats.toLocaleString()+'</strong> ${t.agentSats}</div>':'')
      +(avgRating>0?'<div class="agent-stat" style="'+ratingStyle+'"><span style="color:var(--c-gold)">★</span> <strong>'+avgRating.toFixed(1)+'</strong>'+(reviewCount?' ('+reviewCount+' ${t.agentReviews})':'')+'</div>':'')
      +(pricingSats?'<div class="agent-pricing">\u26A1 '+pricingSats+' ${t.agentSatsPerJob}</div>':'')
      +'</div>';
    html+='<div class="agent-card"'+(a.username?' data-url="'+esc(url)+'" onclick="location.href=this.dataset.url" role="link" tabindex="0" onkeydown="cardKey(event,this.dataset.url)"':'')+' >'
      +'<div class="agent-header">'+avatar
      +'<span class="agent-name">'+rankBadge+esc(a.display_name||a.username||'unknown')+liveBadge+'</span></div>'
      +bio
      +'<div class="agent-services">'+kinds+'</div>'
      +stats
      +'</div>';
  }
  el.innerHTML=html;
}
async function loadStats(){
  try{
    const [statsRes,onlineRes]=await Promise.all([fetch('/api/stats'),fetch('/api/agents/online')]);
    const [stats,online]=await Promise.all([statsRes.json(),onlineRes.json()]);
    const onlineCount=online.agents?.length||online.data?.length||0;
    const bar=document.getElementById('stats-bar');
    if(bar)bar.innerHTML=
      '<a href="/agents?online=1" style="text-decoration:none;color:inherit"><span class="status-dot dot-live"></span><strong>'+onlineCount+'</strong> ${t.online}</a>'+
      '<span>\u2713 <strong>'+(stats.total_jobs_completed||0).toLocaleString()+'</strong> ${t.statsCompleted}</span>'+
      '<span>\u26a1 <strong>'+(stats.total_volume_sats||0).toLocaleString()+'</strong> ${t.statsSatsEarned}</span>';
  }catch(e){}
}
async function load(){
  try{
    const url=onlineOnly?'${baseUrl}/api/agents/online':'${baseUrl}/api/agents?limit=50&page=1';
    const el=document.getElementById('agents');
    el.innerHTML='<div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px"></div>';
    const r=await fetch(url);
    if(!r.ok){el.innerHTML='<div class="error-msg"><span>Failed to load agents</span><button onclick="load()">retry</button></div>';return}
    const data=await r.json();
    allAgentsCache=data.agents||data;
    renderAgents(allAgentsCache);
  }catch(e){
    console.error(e);
    document.getElementById('agents').innerHTML='<div class="error-msg"><span>Network error</span><button onclick="load()">retry</button></div>';
  }
}
updateOnlineBtn();
load();
loadStats();
</script>`
  return c.html(pageLayout({
    title: t.agentsTitle,
    description: t.agentsCta.replace(/<[^>]*>/g, ''),
    baseUrl,
    currentPath: '/agents',
    lang,
    feedHeader: 'Agents',
    pageCSS,
    scripts,
    wideCenter: true,
  }, content))
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
  let userResult: (typeof users.$inferSelect)[] = []
  if (username.startsWith('npub1')) {
    const hex = npubToPubkey(username)
    if (hex) {
      userResult = await db.select().from(users).where(eq(users.nostrPubkey, hex)).limit(1)
    } else {
      userResult = []
    }
  } else if (/^[0-9a-f]{64}$/i.test(username)) {
    userResult = await db.select().from(users).where(eq(users.nostrPubkey, username.toLowerCase())).limit(1)
  } else {
    userResult = await db.select().from(users).where(eq(users.username, username)).limit(1)
  }
  if (userResult.length === 0) {
    // npub/hex identifiers not in our DB → redirect to Nostr profile viewer
    if (username.startsWith('npub1') || /^[0-9a-f]{64}$/i.test(username)) {
      const npubId = username.startsWith('npub1') ? username : (await import('../services/nostr')).pubkeyToNpub(username)
      return c.redirect(`https://njump.me/${npubId}`, 302)
    }
    return c.html(pageLayout({
      title: `${t.notFound} — 2020117`,
      baseUrl,
      currentPath: '/agents/' + username,
      lang,
    }, `<main role="alert" style="display:flex;align-items:center;justify-content:center;min-height:80vh">
<div style="text-align:center"><h1 style="color:var(--c-nav);font-size:48px">404</h1><p>${t.notFound}</p><a href="/agents${lang ? '?lang=' + lang : ''}" style="color:var(--c-accent);font-size:14px">${t.back}</a></div>
</main>`), 404)
  }

  const u = userResult[0]
  const npub = u.nostrPubkey ? pubkeyToNpub(u.nostrPubkey) : ''
  const displayName = u.displayName || u.username || username
  const avatarUrl = u.avatarUrl || beamDataUri(u.nostrPubkey || username, 80)
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
    5001: 'summarization', 5002: 'translation', 5050: 'text generation',
    5100: 'image generation', 5200: 'text-to-image', 5250: 'video generation',
    5300: 'content discovery', 5301: 'speech-to-text',
  }

  // Escape helper
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // Collect kind labels, models, features from services
  const kindLabels: string[] = []
  const kindNums: number[] = []
  const allModels: string[] = []
  const allFeatures: string[] = []
  for (const s of services) {
    for (const k of (JSON.parse(s.kinds) as number[] || [])) {
      const label = DVM_KIND_LABELS[k] || `Kind ${k}`
      if (!kindLabels.includes(label)) kindLabels.push(label)
      if (!kindNums.includes(k)) kindNums.push(k)
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

  // Chat link — for text (5050) or image (5100) agents
  const chatKind = kindNums.includes(5050) ? 5050 : kindNums.includes(5100) ? 5100 : null
  const chatLinkHtml = chatKind && u.nostrPubkey
    ? `<a href="/chat?to=${encodeURIComponent(u.nostrPubkey)}&kind=${chatKind}" style="display:inline-flex;align-items:center;gap:6px;padding:6px 16px;background:var(--c-accent);border:1px solid var(--c-accent);border-radius:4px;color:#fff;font-size:14px;text-decoration:none;transition:opacity 0.2s" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg> Chat</a>`
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
      processing: 'var(--c-blue)', failed: 'var(--c-error)', rejected: 'var(--c-error)',
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
          <code style="flex:1;background:var(--c-surface2);border:1px solid var(--c-border);border-radius:4px;padding:8px 12px;font-size:12px;color:var(--c-accent);word-break:break-all;font-family:monospace">${esc(cmd)}</code>
          <button onclick="(function(btn,text){navigator.clipboard.writeText(text).then(function(){btn.textContent='\u2713 Copied';setTimeout(function(){btn.textContent='Copy'},2000)})})(this,${JSON.stringify(cmd)})" style="flex-shrink:0;background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">Copy</button>
        </div>
      </div>`
    }).join('')}
  </div>
</div>` : ''

  // OG meta
  const ogTitle = `${esc(displayName)} \u2014 2020117 Agent`
  const ogDesc = bio ? esc(bio.slice(0, 160)) : `Agent on 2020117 network`

  const detailPageCSS = `
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
  background:linear-gradient(135deg,color-mix(in srgb,var(--c-teal) 15%,transparent),transparent 50%);
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
  background:var(--c-accent);color:var(--c-bg);
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
  font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1.5px;
  margin-bottom:8px;
}
.tags{
  display:flex;flex-wrap:wrap;gap:6px;
}
.model-tag{
  display:inline-block;
  background:var(--badge-note-bg);
  border:1px solid var(--badge-note-border);
  border-radius:4px;
  padding:3px 10px;
  font-size:13px;
  color:var(--c-gold);
}
.feature-tag{
  display:inline-block;
  background:var(--badge-job-bg);
  border:1px solid var(--badge-job-border);
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
`
  const qs = lang ? '?lang=' + lang : ''
  const detailContent = `
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
    <div class="links" style="display:flex;gap:8px;flex-wrap:wrap">
      ${nostrLinkHtml}
      ${chatLinkHtml}
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
`
  return c.html(pageLayout({
    title: `${esc(displayName)} \u2014 2020117`,
    description: ogDesc,
    baseUrl,
    currentPath: '/agents/' + username,
    lang,
    headExtra: `<meta property="og:type" content="profile">
<meta property="og:image" content="${esc(avatarUrl)}">
<meta property="og:site_name" content="2020117">
<meta name="twitter:image" content="${esc(avatarUrl)}">`,
    feedHeader: `<a href="/agents${qs}" class="feed-back">← Agents</a>${esc(displayName)}`,
    pageCSS: detailPageCSS,
  }, detailContent))
})

export default router
