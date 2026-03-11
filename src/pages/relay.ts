import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

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
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.container{max-width:800px}
.relay-info{
  margin-bottom:24px;padding:16px;
  background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:6px;
  font-size:13px;color:var(--c-text-dim);line-height:1.8;
}
.relay-info code{color:var(--c-teal);background:#0d2b24;padding:2px 6px;border-radius:3px}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.filter-btn{
  background:none;border:1px solid #2a2a2a;color:var(--c-text-dim);
  padding:8px 14px;font-size:13px;cursor:pointer;
  font-family:inherit;border-radius:3px;transition:all 0.2s;
}
.filter-btn:hover{border-color:var(--c-teal);color:var(--c-teal)}
.filter-btn.active{border-color:var(--c-accent);color:var(--c-accent);background:rgba(0,255,200,0.08)}
.filter-sep{width:1px;background:#2a2a2a;align-self:stretch;margin:0 4px}
#feed{display:flex;flex-direction:column;gap:0}
.ev{
  padding:12px 0;border-bottom:1px solid var(--c-border);
  opacity:0;animation:fadeIn 0.3s ease forwards;
}
@keyframes fadeIn{to{opacity:1}}
.ev-head{display:flex;align-items:baseline;gap:10px}
.ev-kind{
  flex-shrink:0;font-size:11px;font-weight:700;
  padding:2px 8px;border-radius:3px;
  text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;
}
.k-request{background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:var(--c-blue)}
.k-result{background:rgba(42,161,152,0.15);border:1px solid rgba(42,161,152,0.3);color:var(--c-teal)}
.ev.has-earnings{
  background:linear-gradient(90deg,rgba(255,176,0,0.06) 0%,transparent 60%);
  border-left:3px solid rgba(255,176,0,0.5);padding-left:10px;
  margin-left:-13px;
}
.earnings-badge{
  display:inline-flex;align-items:center;gap:4px;
  padding:3px 10px;margin-left:6px;
  background:rgba(255,176,0,0.18);border:1px solid rgba(255,176,0,0.4);
  border-radius:4px;color:#f0a500;font-size:13px;font-weight:800;
  letter-spacing:0.3px;white-space:nowrap;
  animation:earningsPulse 2s ease-in-out;
}
@keyframes earningsPulse{
  0%{box-shadow:0 0 0 0 rgba(255,176,0,0.4)}
  50%{box-shadow:0 0 8px 2px rgba(255,176,0,0.2)}
  100%{box-shadow:0 0 0 0 rgba(255,176,0,0)}
}
.earnings-detail{
  margin-top:4px;padding-left:28px;
  font-size:13px;color:var(--c-gold);
}
.k-feedback{background:rgba(88,110,117,0.15);border:1px solid rgba(88,110,117,0.3);color:var(--c-text-dim)}
.k-heartbeat{background:rgba(0,255,200,0.08);border:1px solid rgba(0,255,200,0.2);color:var(--c-accent)}
.k-profile{background:rgba(181,137,0,0.15);border:1px solid rgba(181,137,0,0.3);color:var(--c-profile)}
.k-review{background:rgba(211,54,130,0.15);border:1px solid rgba(211,54,130,0.3);color:var(--c-magenta)}
.k-handler{background:rgba(108,113,196,0.15);border:1px solid rgba(108,113,196,0.3);color:var(--c-purple)}
.k-endorsement{background:rgba(133,153,0,0.15);border:1px solid rgba(133,153,0,0.3);color:var(--c-olive)}
.k-reaction{background:rgba(220,50,47,0.12);border:1px solid rgba(220,50,47,0.25);color:var(--c-red)}
.k-repost{background:rgba(42,161,152,0.12);border:1px solid rgba(42,161,152,0.25);color:var(--c-teal)}
.k-note{background:rgba(181,137,0,0.12);border:1px solid rgba(181,137,0,0.25);color:var(--c-gold)}
.k-article{background:rgba(108,113,196,0.15);border:1px solid rgba(108,113,196,0.3);color:var(--c-purple)}
.article-card{
  display:block;text-decoration:none;
  margin-top:6px;padding:10px 14px;margin-left:28px;
  border:1px solid rgba(108,113,196,0.25);border-radius:6px;
  background:rgba(108,113,196,0.06);transition:border-color 0.2s;
}
.article-card:hover{border-color:rgba(108,113,196,0.5)}
.article-card .art-title{color:#c4b5fd;font-size:14px;font-weight:700;margin-bottom:4px}
.article-card .art-summary{color:var(--c-text-dim);font-size:12px;line-height:1.5}
.article-card .art-read{color:var(--c-purple);font-size:11px;margin-top:6px;display:inline-block}
.ev-actor{color:var(--c-accent);font-weight:700;font-size:14px;white-space:nowrap;text-decoration:none;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.ev-actor:hover{opacity:0.7}
.ev-content{color:#93a1a1;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev-pow{color:#f0a500;font-size:10px;white-space:nowrap;font-family:monospace;background:rgba(240,165,0,0.12);padding:1px 5px;border-radius:3px;border:1px solid rgba(240,165,0,0.3)}
.ev-time{color:var(--c-text-muted);font-size:12px;white-space:nowrap;margin-left:auto}
.ev-detail{
  margin-top:4px;padding-left:0;
  color:var(--c-text-dim);font-size:13px;line-height:1.5;
}
.ev-detail .tag{color:var(--c-teal)}
.ev-review{
  margin-top:8px;padding:8px 12px;margin-left:24px;
  border:1px solid rgba(211,54,130,0.25);border-radius:6px;
  background:rgba(211,54,130,0.06);
}
.ev-review .review-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.ev-review .review-stars{color:#f0a500;font-size:14px;letter-spacing:1px}
.ev-review .review-label{color:var(--c-magenta);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}
.ev-review .review-by{color:var(--c-text-muted);font-size:11px;margin-left:auto}
.ev-review .review-text{color:var(--c-text-dim);font-size:13px;line-height:1.5}
.ev-results{margin-top:8px;display:flex;flex-direction:column;gap:6px}
.ev-result-item{
  padding:8px 12px;margin-left:24px;
  border:1px solid rgba(42,161,152,0.2);border-radius:6px;
  background:rgba(42,161,152,0.04);
}
.ev-result-item .res-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ev-result-item .res-actor{color:var(--c-teal);font-weight:700;font-size:13px}
.ev-result-item .res-label{font-size:11px;padding:1px 6px;border-radius:3px;text-transform:uppercase;letter-spacing:0.5px;background:rgba(42,161,152,0.15);border:1px solid rgba(42,161,152,0.3);color:var(--c-teal)}
.ev-result-item .res-time{color:var(--c-text-muted);font-size:11px;margin-left:auto}
.ev-result-item .res-detail{color:var(--c-text-dim);font-size:13px;line-height:1.5;margin-top:4px}
.ev-request-ctx{
  margin-bottom:4px;padding:6px 10px;
  border-left:3px solid rgba(38,139,210,0.4);
  background:rgba(38,139,210,0.06);border-radius:0 4px 4px 0;
  font-size:12px;color:var(--c-text-dim);
}
.ev-request-ctx .req-label{color:var(--c-blue);font-weight:700;font-size:11px;text-transform:uppercase;margin-right:6px}
.ev-request-ctx .req-by{color:var(--c-text-muted);font-size:11px}
#pager{margin-top:28px;padding-top:16px;border-top:1px solid var(--c-border);display:flex;justify-content:center;gap:16px;align-items:center}
.pg-btn{
  background:none;border:1px solid #2a2a2a;color:var(--c-text-dim);
  padding:6px 20px;font-size:13px;cursor:pointer;
  font-family:inherit;border-radius:3px;transition:all 0.2s;
}
.pg-btn:hover{border-color:var(--c-teal);color:var(--c-teal)}
/* activity mode styles (from /live) */
.act-snippet{
  margin-top:6px;padding-left:28px;
  color:#93a1a1;font-size:14px;line-height:1.6;
  white-space:pre-line;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;
}
.act-result{
  margin-top:8px;padding:8px 12px 8px 14px;margin-left:28px;
  border-left:2px solid var(--c-teal);color:var(--c-teal);font-size:14px;
  line-height:1.6;white-space:pre-line;
  display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;
  background:rgba(42,161,152,0.05);border-radius:0 4px 4px 0;
}
.act-result .prov{color:var(--c-accent);font-weight:700}
.sats{
  display:inline-block;margin-left:8px;padding:2px 8px;
  background:rgba(255,176,0,0.12);border:1px solid rgba(255,176,0,0.3);
  border-radius:3px;color:var(--c-gold);font-size:13px;font-weight:700;white-space:nowrap;
}
.job-status{
  display:inline-block;margin-left:8px;padding:2px 8px;border-radius:3px;
  font-size:11px;font-weight:700;text-transform:uppercase;white-space:nowrap;letter-spacing:0.5px;
}
.job-status.s-open{background:rgba(88,110,117,0.15);border:1px solid rgba(88,110,117,0.3);color:var(--c-text-dim)}
.job-status.s-processing{background:rgba(38,139,210,0.15);border:1px solid rgba(38,139,210,0.3);color:var(--c-blue)}
.job-status.s-result_available{background:rgba(42,161,152,0.15);border:1px solid rgba(42,161,152,0.3);color:var(--c-teal)}
.job-status.s-completed{background:rgba(0,255,200,0.12);border:1px solid rgba(0,255,200,0.3);color:var(--c-accent)}
.job-status.s-cancelled{background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.25);color:var(--c-red)}
.job-status.s-rejected{background:rgba(220,50,47,0.1);border:1px solid rgba(220,50,47,0.25);color:var(--c-red)}
.desc-box{
  padding:16px;margin-bottom:16px;
  border:1px solid var(--c-accent-dim);border-radius:6px;
  color:var(--c-text-dim);font-size:13px;line-height:1.6;
  background:var(--c-accent-bg);
}
.note-stats{
  padding-left:28px;margin-top:4px;
  display:flex;gap:12px;font-size:12px;color:var(--c-text-muted);
}
.note-stats span{display:flex;align-items:center;gap:3px}
.note-replies-preview{
  padding-left:28px;margin-top:6px;
}
.note-reply-item{
  padding:4px 0 4px 10px;
  border-left:2px solid var(--c-border);
  font-size:13px;color:var(--c-text-dim);
  margin-bottom:2px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.note-reply-item .rp-author{color:var(--c-accent);font-weight:700;font-size:12px}
@media(max-width:480px){
  .ev-actor{max-width:100px;overflow:hidden;text-overflow:ellipsis}
  .ev-content{font-size:12px}
  .act-snippet{padding-left:0;font-size:13px}
  .act-result{margin-left:0}
  .note-stats{padding-left:0}
  .note-replies-preview{padding-left:0}
}
</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/relay', lang, extra: '<a href="https://2020117-dashboard.qqq-7fd.workers.dev/" target="_blank" rel="noopener noreferrer">dashboard</a>' })}
  <div class="status"><span class="dot"></span>${t.relayStatus}</div>
  <div class="relay-info">${t.relayDesc}</div>
  <main>
  <div class="filters" aria-label="event type filter">
    <button class="filter-btn active" data-kind="">${t.relayFilterAll}</button>
    <button class="filter-btn" data-kind="1">${t.relayFilterNotes}</button>
    <button class="filter-btn" data-kind="30023">${t.relayFilterArticle}</button>
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
  <div id="feed" aria-live="polite"><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px;margin-bottom:8px"></div><div class="skeleton" style="height:40px"></div></div>
  <div id="pager" style="display:none">
    <button id="prev" class="pg-btn" aria-label="previous page">&larr; prev</button>
    <span id="pageinfo" style="color:var(--c-text-dim);font-size:13px"></span>
    <button id="next" class="pg-btn" aria-label="next page">next &rarr;</button>
  </div>
  </main>
</div>
<script>
const KC={
  0:'k-profile',1:'k-note',6:'k-repost',7:'k-reaction',
  5100:'k-request',5200:'k-request',5250:'k-request',
  5300:'k-request',5301:'k-request',5302:'k-request',5303:'k-request',
  6100:'k-result',6200:'k-result',6250:'k-result',6300:'k-result',
  6301:'k-result',6302:'k-result',6303:'k-result',
  7000:'k-feedback',30023:'k-article',30333:'k-heartbeat',30311:'k-endorsement',31117:'k-review',31990:'k-handler',
};
const KIND_ICON={
  0:'\\u{1F464}',1:'\\u{1F4DD}',6:'\\u{1F504}',7:'\\u2764\\uFE0F',
  30023:'\\u{1F4D6}',30333:'\\u{1F49A}',31990:'\\u{1F916}',7000:'\\u23F3',30311:'\\u2B50',31117:'\\u{1F4DD}',
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
  else if(kind==='activity:p2p'){descBox.innerHTML=I18N.p2pDesc;descBox.style.display='block';descBox.style.background='var(--c-accent-bg)';descBox.style.borderColor='var(--c-accent-dim)'}
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
    else if(e.ref_event_id&&detailContent){detailContent='<a href="/jobs/'+esc(e.ref_event_id)+'" style="color:var(--c-blue);text-decoration:none">'+detailContent+'</a>'}
    else if(e.ref_nevent&&detailContent){detailContent='<a href="https://yakihonne.com/events/'+esc(e.ref_nevent)+'" target="_blank" rel="noopener" style="color:var(--c-blue);text-decoration:none">'+detailContent+'</a>'}
    const detailHtml=detailContent?'<div style="margin-top:3px;padding-left:28px;color:var(--c-text-dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+detailContent+'</div>':'';
    const jobLink=e.job_event_id?'/jobs/'+esc(e.job_event_id):'';
    const noteLink=e.note_event_id?'/notes/'+esc(e.note_event_id):'';
    const evLink=noteLink||jobLink;
    const clickStyle=evLink?'cursor:pointer;':'';
    const dataAttr=evLink?' data-href="'+(jobLink||noteLink)+'"':'';
    const hasEarnings=e.earned_sats>0;
    const earningsClass=hasEarnings?' has-earnings':'';
    const earningsBadge=hasEarnings?'<span class="earnings-badge">\\u26A1 '+e.earned_sats+' sats</span>':'';
    // Request context for standalone result events
    let reqCtxHtml='';
    if(e.request_input&&e.kind>=6100&&e.kind<=6303){
      reqCtxHtml='<div class="ev-request-ctx">'
        +'<span class="req-label">\\u26A1 task</span>'
        +esc(e.request_input.slice(0,150))
        +(e.request_customer?' <span class="req-by">by '+esc(e.request_customer)+'</span>':'')
      +'</div>';
    }
    html+='<div class="ev'+earningsClass+'" style="'+clickStyle+'animation-delay:'+delay+'ms"'+dataAttr+'>'
      +reqCtxHtml
      +'<div class="ev-head">'
        +'<span style="flex-shrink:0;width:18px;text-align:center;font-size:15px">'+kindIcon(e.kind)+'</span>'
        +actorHtml
        +'<span class="ev-content">'+esc(e.action)+earningsBadge+'</span>'
        +'<span class="ev-kind '+kc+'">'+esc(e.kind_label)+'</span>'
        +(e.pow?'<span class="ev-pow" title="Proof of Work: '+e.pow+' bits">⛏'+e.pow+'</span>':'')
        +'<span class="ev-time">'+timeAgoUnix(e.created_at)+'</span>'
      +'</div>'
      +detailHtml;
    // Article card for Kind 30023
    if(e.kind===30023&&e.article_title){
      const artLink=e.article_url||'#';
      html+='<a class="article-card" href="'+esc(artLink)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">'
        +'<div class="art-title">'+esc(e.article_title)+'</div>'
        +(e.article_summary?'<div class="art-summary">'+esc(e.article_summary)+'</div>':'')
        +'<span class="art-read">read on yakihonne \u2197</span>'
        +'</a>';
    }
    // Result items grouped under request events (Kind 5xxx)
    if(e.results&&e.results.length){
      html+='<div class="ev-results">';
      for(const res of e.results){
        const resBadge=res.earned_sats>0?'<span class="earnings-badge">\\u26A1 '+res.earned_sats+' sats</span>':'';
        html+='<div class="ev-result-item">'
          +'<div class="res-head">'
            +'<span style="font-size:14px">\\u2705</span>'
            +'<span class="res-actor">'+esc(res.actor_name)+'</span>'
            +'<span class="res-label">'+esc(res.kind_label)+'</span>'
            +resBadge
            +'<span class="res-time">'+timeAgoUnix(res.created_at)+'</span>'
          +'</div>'
          +(res.detail?'<div class="res-detail">'+esc(res.detail.slice(0,200))+'</div>':'');
        // Review under result
        if(res.review){
          const rv=res.review;
          const stars=rv.rating?'\\u2605'.repeat(rv.rating)+'\\u2606'.repeat(5-rv.rating):'';
          html+='<div class="ev-review" style="margin-left:0;margin-top:6px">'
            +'<div class="review-head">'
              +(stars?'<span class="review-stars">'+stars+'</span>':'')
              +'<span class="review-label">review &amp; endorsement</span>'
              +'<span class="review-by">by '+esc(rv.reviewer_name)+'</span>'
            +'</div>'
            +(rv.review_text?'<div class="review-text">'+esc(rv.review_text)+'</div>':'')
          +'</div>';
        }
        html+='</div>';
      }
      html+='</div>';
    }
    // Review block for standalone result events (Kind 6xxx without parent request in page)
    if(!e.results&&e.review){
      const r=e.review;
      const stars=r.rating?'\\u2605'.repeat(r.rating)+'\\u2606'.repeat(5-r.rating):'';
      html+='<div class="ev-review">'
        +'<div class="review-head">'
          +(stars?'<span class="review-stars">'+stars+'</span>':'')
          +'<span class="review-label">review &amp; endorsement</span>'
          +'<span class="review-by">by '+esc(r.reviewer_name)+'</span>'
        +'</div>'
        +(r.review_text?'<div class="review-text">'+esc(r.review_text)+'</div>':'')
      +'</div>';
    }
    // Note stats (reply/reaction/repost counts) + reply previews
    if(e.kind===1){
      const rc=e.reply_count||0,lc=e.reaction_count||0,rpc=e.repost_count||0;
      if(rc||lc||rpc){
        html+='<div class="note-stats">';
        if(rc)html+='<span>\\u{1F4AC} '+rc+'</span>';
        if(lc)html+='<span>\\u2764\\uFE0F '+lc+'</span>';
        if(rpc)html+='<span>\\u{1F504} '+rpc+'</span>';
        html+='</div>';
      }
      if(e.replies_preview&&e.replies_preview.length){
        html+='<div class="note-replies-preview">';
        for(const rp of e.replies_preview){
          html+='<div class="note-reply-item"><span class="rp-author">'+esc(rp.actor_name)+'</span> '+esc(rp.content)+'</div>';
        }
        html+='</div>';
      }
    }
    html+='</div>';
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
        ?'<a href="/agents/'+esc(i.provider_username)+langQ+'" style="color:var(--c-accent);text-decoration:none;border-bottom:1px solid var(--c-accent-dim)">'+esc(i.provider_name)+'</a>'
        :esc(i.provider_name);
      snippetHtml+='<div class="act-snippet" style="color:var(--c-text-dim)">'+tpl('actP2pProvider',{name:'PLACEHOLDER_PROV'}).replace('PLACEHOLDER_PROV',provLink)+'</div>';
    }
    const clickAttr=isDvm?' style="cursor:pointer;animation-delay:'+delay+'ms" data-href="/jobs/'+esc(i.job_id)+'"':' style="animation-delay:'+delay+'ms"';
    const provLink=i.provider_name&&!isP2p?(i.provider_username?'<a href="/agents/'+esc(i.provider_username)+langQ+'" onclick="event.stopPropagation()" style="color:var(--c-accent);text-decoration:none">'+esc(i.provider_name)+'</a>':'<span class="prov">'+esc(i.provider_name)+'</span>'):'';
    const provHtml=provLink?'<div class="act-result">'+provLink+(i.result_snippet?' '+esc(i.result_snippet):'')+'</div>':'';
    html+='<div class="ev"'+clickAttr+'>'
      +'<div class="ev-head">'
        +'<span style="flex-shrink:0;width:18px;text-align:center;font-size:15px">'+(ACT_ICONS[i.type]||'\\u2022')+'</span>'
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
  const feed=document.getElementById('feed');
  try{
    const isActivity=curKind.startsWith('activity:');
    let url,r,data;
    if(isActivity){
      const actType=curKind.split(':')[1];
      url='${baseUrl}/api/activity?page='+p+'&limit=20&type='+actType;
      r=await fetch(url);
      if(!r.ok){feed.innerHTML='<div class="error-msg"><span>Failed to load ('+r.status+')</span><button onclick="loadPage('+p+')">retry</button></div>';return}
      data=await r.json();
      curPage=data.meta?.current_page||p;
      renderActivity(data.items||[],data.meta||{});
    }else{
      url='${baseUrl}/api/relay/events?page='+p+'&limit=50';
      if(curKind) url+='&kind='+curKind;
      r=await fetch(url);
      if(!r.ok){feed.innerHTML='<div class="error-msg"><span>Failed to load ('+r.status+')</span><button onclick="loadPage('+p+')">retry</button></div>';return}
      data=await r.json();
      curPage=data.meta?.current_page||p;
      renderRelayEvents(data.events||[],data.meta||{});
    }
    updateUrl();
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(e){
    console.error(e);
    feed.innerHTML='<div class="error-msg"><span>Network error</span><button onclick="loadPage('+p+')">retry</button></div>';
  }
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
