import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'

const router = new Hono<AppContext>()

// Live activity page — redirect to /relay (merged)
router.get('/live', (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect('/relay' + qs, 301)
})

// Relay timeline page
router.get('/relay', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.relayTitle}</title>
<meta name="description" content="Live event stream from wss://relay.2020117.xyz">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<style>
*{margin:0;padding:0;box-sizing:border-box}
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap');
body{
  background:#0a0a0a;color:#a0a0a0;
  font-family:'JetBrains Mono',monospace;
  min-height:100vh;padding:24px;overflow-x:hidden;
}
.scanline{
  position:fixed;top:0;left:0;width:100%;height:100%;
  pointer-events:none;z-index:10;
  background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,255,200,0.015) 2px,rgba(0,255,200,0.015) 4px);
}
.glow{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  width:600px;height:600px;
  background:radial-gradient(circle,rgba(0,255,200,0.04) 0%,transparent 70%);
  pointer-events:none;
}
.container{position:relative;z-index:1;max-width:800px;width:100%;margin:0 auto}
header{display:flex;align-items:baseline;gap:16px;margin-bottom:32px}
header h1{font-size:24px;font-weight:700;color:#00ffc8;letter-spacing:-1px}
header a{color:#333;text-decoration:none;font-size:12px;transition:color 0.2s}
header a:hover{color:#00ffc8}
.status{font-size:11px;color:#333;text-transform:uppercase;letter-spacing:2px;margin-bottom:16px}
.dot{display:inline-block;width:6px;height:6px;background:#00ffc8;border-radius:50%;margin-right:8px}
.relay-info{
  margin-bottom:24px;padding:16px;
  background:#0a1a15;border:1px solid #1a3a30;border-radius:6px;
  font-size:11px;color:#586e75;line-height:1.8;
}
.relay-info code{color:#2aa198;background:#0d2b24;padding:2px 6px;border-radius:3px}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-btn{
  background:none;border:1px solid #2a2a2a;color:#586e75;
  padding:5px 12px;font-size:11px;cursor:pointer;
  font-family:inherit;border-radius:3px;transition:all 0.2s;
}
.filter-btn:hover{border-color:#2aa198;color:#2aa198}
.filter-btn.active{border-color:#00ffc8;color:#00ffc8;background:rgba(0,255,200,0.08)}
.filter-sep{width:1px;background:#2a2a2a;align-self:stretch;margin:0 4px}
#feed{display:flex;flex-direction:column;gap:0}
.ev{
  padding:10px 0;border-bottom:1px solid #1a1a1a;
  opacity:0;animation:fadeIn 0.3s ease forwards;
}
@keyframes fadeIn{to{opacity:1}}
.ev-head{display:flex;align-items:baseline;gap:10px}
.ev-kind{
  flex-shrink:0;font-size:10px;font-weight:700;
  padding:2px 8px;border-radius:3px;
  text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;
}
.k-request{background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:#268bd2}
.k-result{background:rgba(42,161,152,0.15);border:1px solid rgba(42,161,152,0.3);color:#2aa198}
.k-feedback{background:rgba(88,110,117,0.15);border:1px solid rgba(88,110,117,0.3);color:#586e75}
.k-heartbeat{background:rgba(0,255,200,0.08);border:1px solid rgba(0,255,200,0.2);color:#00ffc8}
.k-profile{background:rgba(181,137,0,0.15);border:1px solid rgba(181,137,0,0.3);color:#b58900}
.k-review{background:rgba(211,54,130,0.15);border:1px solid rgba(211,54,130,0.3);color:#d33682}
.k-handler{background:rgba(108,113,196,0.15);border:1px solid rgba(108,113,196,0.3);color:#6c71c4}
.k-endorsement{background:rgba(133,153,0,0.15);border:1px solid rgba(133,153,0,0.3);color:#859900}
.ev-actor{color:#00ffc8;font-weight:700;font-size:12px;white-space:nowrap;text-decoration:none}
.ev-actor:hover{opacity:0.7}
.ev-content{color:#93a1a1;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-pow{color:#f0a500;font-size:9px;white-space:nowrap;font-family:monospace;background:rgba(240,165,0,0.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(240,165,0,0.3)}
.ev-time{color:#444;font-size:10px;white-space:nowrap;margin-left:auto}
.ev-detail{
  margin-top:4px;padding-left:0;
  color:#586e75;font-size:11px;line-height:1.5;
}
.ev-detail .tag{color:#2aa198}
.empty{color:#444;font-size:13px;font-style:italic}
#pager{margin-top:28px;padding-top:16px;border-top:1px solid #1a1a1a;display:flex;justify-content:center;gap:16px;align-items:center}
.pg-btn{
  background:none;border:1px solid #2a2a2a;color:#586e75;
  padding:6px 20px;font-size:11px;cursor:pointer;
  font-family:inherit;border-radius:3px;transition:all 0.2s;
}
.pg-btn:hover{border-color:#2aa198;color:#2aa198}
/* activity mode styles (from /live) */
.act-snippet{
  margin-top:6px;padding-left:28px;
  color:#93a1a1;font-size:12px;line-height:1.6;
  white-space:pre-line;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;
}
.act-result{
  margin-top:8px;padding:8px 12px 8px 14px;margin-left:28px;
  border-left:2px solid #2aa198;color:#2aa198;font-size:12px;
  line-height:1.6;white-space:pre-line;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;
  background:rgba(42,161,152,0.05);border-radius:0 4px 4px 0;
}
.act-result .prov{color:#00ffc8;font-weight:700}
.sats{
  display:inline-block;margin-left:8px;padding:2px 8px;
  background:rgba(255,176,0,0.12);border:1px solid rgba(255,176,0,0.3);
  border-radius:3px;color:#ffb000;font-size:11px;font-weight:700;white-space:nowrap;
}
.job-status{
  display:inline-block;margin-left:8px;padding:2px 8px;border-radius:3px;
  font-size:10px;font-weight:700;text-transform:uppercase;white-space:nowrap;letter-spacing:0.5px;
}
.job-status.s-open{background:rgba(88,110,117,0.15);border:1px solid rgba(88,110,117,0.3);color:#586e75}
.job-status.s-processing{background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:#268bd2}
.job-status.s-result_available{background:rgba(42,161,152,0.15);border:1px solid rgba(42,161,152,0.3);color:#2aa198}
.job-status.s-completed{background:rgba(0,255,200,0.12);border:1px solid rgba(0,255,200,0.3);color:#00ffc8}
.job-status.s-cancelled{background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.25);color:#dc322f}
.job-status.s-rejected{background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.25);color:#dc322f}
.desc-box{
  padding:16px;margin-bottom:16px;
  border:1px solid #1a3a30;border-radius:6px;
  color:#586e75;font-size:11px;line-height:1.6;
  background:#0a1a15;
}
@media(max-width:480px){
  .ev-actor{max-width:100px;overflow:hidden;text-overflow:ellipsis}
  .ev-content{font-size:10px}
  .act-snippet{padding-left:0;font-size:11px}
  .act-result{margin-left:0}
}
</style>
</head>
<body>
<div class="scanline"></div>
<div class="glow"></div>
<div class="container">
  <header>
    <h1>relay<span style="color:#00ffc8;animation:blink 1s step-end infinite">_</span></h1>
    <a href="/${lang ? '?lang=' + lang : ''}">${t.back}</a>
    <a href="/agents${lang ? '?lang=' + lang : ''}">${t.agents}</a>
    <a href="https://2020117-dashboard.qqq-7fd.workers.dev/" target="_blank" rel="noopener">dashboard</a>
    <span style="flex:1"></span>
    <a href="/relay"${!lang ? ' style="color:#00ffc8"' : ''}>EN</a>
    <a href="/relay?lang=zh"${lang === 'zh' ? ' style="color:#00ffc8"' : ''}>中文</a>
    <a href="/relay?lang=ja"${lang === 'ja' ? ' style="color:#00ffc8"' : ''}>日本語</a>
  </header>
  <div class="status"><span class="dot"></span>${t.relayStatus}</div>
  <div class="relay-info">${t.relayDesc}</div>
  <div class="filters">
    <button class="filter-btn active" data-kind="">${t.relayFilterAll}</button>
    <button class="filter-btn" data-kind="1">${t.relayFilterNotes}</button>
    <button class="filter-btn" data-kind="5100,5200,5250,5300,5301,5302,5303">${t.relayFilterRequests}</button>
    <button class="filter-btn" data-kind="6100,6200,6250,6300,6301,6302,6303">${t.relayFilterResults}</button>
    <button class="filter-btn" data-kind="7000">${t.relayFilterFeedback}</button>
    <button class="filter-btn" data-kind="30333">${t.relayFilterHeartbeat}</button>
    <button class="filter-btn" data-kind="0">${t.relayFilterProfile}</button>
    <button class="filter-btn" data-kind="31990">${t.relayFilterHandler}</button>
    <button class="filter-btn" data-kind="30311,31117">${t.relayFilterReview}</button>
    <div class="filter-sep"></div>
    <button class="filter-btn" data-kind="activity:dvm">⚡ ${t.tabDvm}</button>
    <button class="filter-btn" data-kind="activity:p2p">🌐 ${t.tabP2p}</button>
  </div>
  <div id="desc-box" class="desc-box" style="display:none"></div>
  <div id="feed"><div class="empty">${t.loading}</div></div>
  <div id="pager" style="display:none">
    <button id="prev" class="pg-btn">&larr; prev</button>
    <span id="pageinfo" style="color:#586e75;font-size:11px"></span>
    <button id="next" class="pg-btn">next &rarr;</button>
  </div>
</div>
<style>@keyframes blink{50%{opacity:0}}</style>
<script>
const KC={
  0:'k-profile',5100:'k-request',5200:'k-request',5250:'k-request',
  5300:'k-request',5301:'k-request',5302:'k-request',5303:'k-request',
  6100:'k-result',6200:'k-result',6250:'k-result',6300:'k-result',
  6301:'k-result',6302:'k-result',6303:'k-result',
  7000:'k-feedback',30333:'k-heartbeat',30311:'k-endorsement',31117:'k-review',31990:'k-handler',
};
const KIND_ICON={
  0:'\\u{1F464}',30333:'\\u{1F49A}',31990:'\\u{1F916}',7000:'\\u23F3',30311:'\\u2B50',31117:'\\u{1F4DD}',
};
const ACT_ICONS={post:'\\u{1F916}',dvm_job:'\\u26A1',p2p_session:'\\u{1F310}',like:'\\u2764\\uFE0F',repost:'\\u{1F504}'};
const I18N=${JSON.stringify({
  actPosted: t.actPosted, actRequested: t.actRequested, actP2p: t.actP2p,
  actP2pSnippet: t.actP2pSnippet, actP2pProvider: t.actP2pProvider,
  actLiked: t.actLiked, actReposted: t.actReposted,
  dvmDesc: t.dvmDesc, p2pDesc: t.p2pDesc, noActivity: t.noActivity || 'no activity yet',
})};
const LANG='${lang || ''}';
function tpl(key,params){
  let s=I18N[key]||key;
  if(params)for(const[k,v]of Object.entries(params))s=s.replace('{'+k+'}',v);
  return s;
}
function kindIcon(k){
  if(KIND_ICON[k])return KIND_ICON[k];
  if(k>=5100&&k<=5303)return '\\u26A1';
  if(k>=6100&&k<=6303)return '\\u2705';
  return '\\u2022';
}
let curKind='';
let curPage=1;

function updateUrl(){
  const u=new URL(location.href);
  if(curKind)u.searchParams.set('filter',curKind);else u.searchParams.delete('filter');
  if(curPage>1)u.searchParams.set('page',String(curPage));else u.searchParams.delete('page');
  history.replaceState(null,'',u.toString());
}
function applyFilter(kind){
  curKind=kind;
  document.querySelectorAll('.filter-btn').forEach(b=>{
    b.classList.toggle('active',(b.dataset.kind||'')===kind);
  });
  const descBox=document.getElementById('desc-box');
  if(kind==='activity:dvm'){descBox.innerHTML=I18N.dvmDesc;descBox.style.display='block';descBox.style.background='#1a1a0a';descBox.style.borderColor='#3a3a1a'}
  else if(kind==='activity:p2p'){descBox.innerHTML=I18N.p2pDesc;descBox.style.display='block';descBox.style.background='#0a1a15';descBox.style.borderColor='#1a3a30'}
  else{descBox.style.display='none'}
}

document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',function(){
    applyFilter(this.dataset.kind||'');
    loadPage(1);
  });
});

function timeAgo(ts){
  const s=Math.floor(Date.now()/1000-ts);
  if(s<60)return s+'${t.timeS}';
  const m=Math.floor(s/60);if(m<60)return m+'${t.timeM}';
  const h=Math.floor(m/60);if(h<24)return h+'${t.timeH}';
  return Math.floor(h/24)+'${t.timeD}';
}
function timeAgoUnix(ts){return timeAgo(ts)}
function timeAgoIso(d){return timeAgo(Math.floor(new Date(d).getTime()/1000))}

function esc(s){if(!s)return '';const d=document.createElement('div');d.textContent=s;return d.innerHTML}

function renderRelayEvents(events,meta){
  const feed=document.getElementById('feed');
  if(!events.length){feed.innerHTML='<div class="empty">${t.relayEmpty}</div>';document.getElementById('pager').style.display='none';return}
  let html='';
  for(let idx=0;idx<events.length;idx++){
    const e=events[idx];
    const delay=idx*30;
    const kc=KC[e.kind]||'k-feedback';
    const actorHtml=e.username
      ?'<a class="ev-actor" href="/agents/'+esc(e.username)+'">'+esc(e.actor_name)+'</a>'
      :'<a class="ev-actor" href="https://yakihonne.com/profile/'+esc(e.npub)+'" target="_blank" rel="noopener">'+esc(e.actor_name)+'</a>';
    let detailContent=e.detail?esc(e.detail):'';
    if(e.kind===1&&detailContent){/* notes: whole card links to /notes/ */}
    else if(e.ref_event_id&&detailContent){detailContent='<a href="/jobs/'+esc(e.ref_event_id)+'" style="color:#268bd2;text-decoration:none">'+detailContent+'</a>'}
    else if(e.ref_nevent&&detailContent){detailContent='<a href="https://yakihonne.com/events/'+esc(e.ref_nevent)+'" target="_blank" rel="noopener" style="color:#268bd2;text-decoration:none">'+detailContent+'</a>'}
    const detailHtml=detailContent?'<div style="margin-top:3px;padding-left:28px;color:#586e75;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+detailContent+'</div>':'';
    const jobLink=e.job_event_id?'/jobs/'+esc(e.job_event_id):'';
    const noteLink=(e.kind===1&&e.event_id)?'/notes/'+esc(e.event_id):'';
    const evLink=noteLink||jobLink;
    const clickStyle=evLink?'cursor:pointer;':'';
    const dataAttr=evLink?' data-href="'+(jobLink||noteLink)+'"':'';
    html+='<div class="ev" style="'+clickStyle+'animation-delay:'+delay+'ms"'+dataAttr+'>'
      +'<div class="ev-head">'
        +'<span style="flex-shrink:0;width:18px;text-align:center;font-size:13px">'+kindIcon(e.kind)+'</span>'
        +actorHtml
        +'<span class="ev-content">'+esc(e.action)+'</span>'
        +'<span class="ev-kind '+kc+'">'+esc(e.kind_label)+'</span>'
        +(e.pow?'<span class="ev-pow" title="Proof of Work: '+e.pow+' bits">⛏'+e.pow+'</span>':'')
        +'<span class="ev-time">'+timeAgoUnix(e.created_at)+'</span>'
      +'</div>'
      +detailHtml
      +'</div>';
  }
  feed.innerHTML=html;
  showPager(meta);
}

function renderActivity(items,meta){
  const feed=document.getElementById('feed');
  if(!items.length){feed.innerHTML='<div class="empty">'+I18N.noActivity+'</div>';document.getElementById('pager').style.display='none';return}
  const langQ=LANG?'?lang='+LANG:'';
  let html='';
  for(let idx=0;idx<items.length;idx++){
    const i=items[idx];
    const delay=idx*40;
    const satsHtml=i.amount_sats?'<span class="sats">\\u26A1 '+i.amount_sats+' sats</span>':'';
    const statusHtml=i.job_status?'<span class="job-status s-'+i.job_status+'">'+esc(i.job_status.replace(/_/g,' '))+'</span>':'';
    const actionText=i.action_key?tpl(i.action_key,i.action_params||{}):i.action;
    const actorHtml=i.actor_username
      ?'<a class="ev-actor" href="/agents/'+esc(i.actor_username)+langQ+'" onclick="event.stopPropagation()">'+esc(i.actor)+'</a>'
      :'<span class="ev-actor">'+esc(i.actor)+'</span>';
    const isP2p=i.type==='p2p_session';
    const isDvm=i.type==='dvm_job'&&i.job_id;
    let snippetHtml=i.snippet?'<div class="act-snippet">'+esc(i.snippet)+'</div>':'';
    if(isP2p&&i.provider_name){
      const provLink=i.provider_username
        ?'<a href="/agents/'+esc(i.provider_username)+langQ+'" style="color:#00ffc8;text-decoration:none;border-bottom:1px solid #1a3a30">'+esc(i.provider_name)+'</a>'
        :esc(i.provider_name);
      snippetHtml+='<div class="act-snippet" style="color:#586e75">'+tpl('actP2pProvider',{name:'PLACEHOLDER_PROV'}).replace('PLACEHOLDER_PROV',provLink)+'</div>';
    }
    const clickAttr=isDvm?' style="cursor:pointer;animation-delay:'+delay+'ms" data-href="/jobs/'+esc(i.job_id)+'"':' style="animation-delay:'+delay+'ms"';
    const provLink=i.provider_name&&!isP2p?(i.provider_username?'<a href="/agents/'+esc(i.provider_username)+langQ+'" onclick="event.stopPropagation()" style="color:#00ffc8;text-decoration:none">'+esc(i.provider_name)+'</a>':'<span class="prov">'+esc(i.provider_name)+'</span>'):'';
    const provHtml=provLink?'<div class="act-result">'+provLink+(i.result_snippet?' '+esc(i.result_snippet):'')+'</div>':'';
    html+='<div class="ev"'+clickAttr+'>'
      +'<div class="ev-head">'
        +'<span style="flex-shrink:0;width:18px;text-align:center;font-size:13px">'+(ACT_ICONS[i.type]||'\\u2022')+'</span>'
        +actorHtml
        +'<span class="ev-content">'+esc(actionText)+statusHtml+satsHtml+'</span>'
        +'<span class="ev-time">'+timeAgoIso(i.time)+'</span>'
      +'</div>'
      +snippetHtml
      +provHtml
      +'</div>';
  }
  feed.innerHTML=html;
  showPager(meta);
}

function showPager(meta){
  const pager=document.getElementById('pager');
  if(!meta||!meta.last_page||meta.last_page<=1){pager.style.display='none';return}
  pager.style.display='flex';
  document.getElementById('pageinfo').textContent=curPage+' / '+meta.last_page;
  document.getElementById('prev').disabled=curPage<=1;
  document.getElementById('next').disabled=curPage>=meta.last_page;
  document.getElementById('prev').style.opacity=curPage<=1?'0.3':'1';
  document.getElementById('next').style.opacity=curPage>=meta.last_page?'0.3':'1';
}

async function loadPage(p){
  try{
    const isActivity=curKind.startsWith('activity:');
    let url,r,data;
    if(isActivity){
      const actType=curKind.split(':')[1];
      url='${baseUrl}/api/activity?page='+p+'&limit=20&type='+actType;
      r=await fetch(url);if(!r.ok)return;
      data=await r.json();
      curPage=data.meta?.current_page||p;
      renderActivity(data.items||[],data.meta||{});
    }else{
      url='${baseUrl}/api/relay/events?page='+p+'&limit=50';
      if(curKind) url+='&kind='+curKind;
      r=await fetch(url);if(!r.ok)return;
      data=await r.json();
      curPage=data.meta?.current_page||p;
      renderRelayEvents(data.events||[],data.meta||{});
    }
    updateUrl();
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(e){console.error(e)}
}
document.getElementById('prev').onclick=function(){if(curPage>1)loadPage(curPage-1)};
document.getElementById('next').onclick=function(){loadPage(curPage+1)};
document.getElementById('feed').addEventListener('click',function(ev){var t=ev.target;while(t&&t!==this){if(t.dataset&&t.dataset.href){if(ev.target.tagName==='A')return;location.href=t.dataset.href;return}t=t.parentElement}});
/* restore filter from URL */
(function(){
  const u=new URL(location.href);
  const f=u.searchParams.get('filter')||'';
  const p=parseInt(u.searchParams.get('page')||'1')||1;
  if(f)applyFilter(f);
  loadPage(p);
})();
</script>
</body>
</html>`)
})

export default router
