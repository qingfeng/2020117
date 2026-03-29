import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav, pageFooter } from './shared-styles'

const router = new Hono<AppContext>()

// Old URLs redirect to /
router.get('/live', (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect('/' + qs, 301)
})
router.get('/relay', (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect('/' + qs, 301)
})
router.get('/timeline', (c) => {
  const qs = new URL(c.req.url).search
  return c.redirect('/' + qs, 301)
})

// Legacy timeline page (kept for direct access, same as /)
router.get('/timeline-legacy', (c) => {
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
.container{max-width:640px}
/* Twitter-style post list */
#feed{border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.post{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid var(--c-border);transition:background 0.1s}
.post:last-child{border-bottom:none}
.post:hover{background:rgba(255,255,255,0.02)}
.post-avatar{width:42px;height:42px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--c-surface2)}
.post-right{flex:1;min-width:0}
.post-header{display:flex;align-items:center;gap:6px;margin-bottom:5px;flex-wrap:wrap}
.post-name{font-weight:700;font-size:15px;color:var(--c-text);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}
.post-name:hover{text-decoration:underline}
.post-badge{font-size:11px;padding:1px 6px;border-radius:10px;white-space:nowrap}
.badge-note{background:rgba(245,166,35,0.15);color:#f5a623}
.badge-job{background:rgba(59,130,246,0.15);color:#7ba8f0}
.badge-result{background:rgba(34,197,94,0.15);color:#4ade80}
.badge-other{background:rgba(136,136,160,0.12);color:var(--c-text-muted)}
.post-time{font-size:13px;color:var(--c-text-muted);margin-left:auto;white-space:nowrap}
.post-body{font-size:15px;color:var(--c-text);line-height:1.55;margin-bottom:8px;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.post-body-dim{font-size:14px;color:var(--c-text-dim);line-height:1.5;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.post-result{margin-bottom:8px;padding:10px 12px;background:rgba(34,197,94,0.05);border:1px solid rgba(34,197,94,0.18);border-radius:8px}
.post-result-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.post-result-status{font-size:12px;font-weight:600;color:#4ade80}
.post-result-body{font-size:13px;color:var(--c-text-dim);line-height:1.5;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.post-footer{display:flex;align-items:center;gap:16px}
.post-stat{font-size:13px;color:var(--c-text-muted);display:flex;align-items:center;gap:4px}
.post-link{font-size:13px;color:var(--c-accent);text-decoration:none;margin-left:auto}
.post-link:hover{text-decoration:underline}
a.post-stat{color:var(--c-text-muted);text-decoration:none}
a.post-stat:hover{color:var(--c-accent)}
.sats-pill{font-size:12px;font-weight:600;color:var(--c-gold);display:flex;align-items:center;gap:3px}
/* For: request label */
.post-for{font-size:13px;color:var(--c-text-muted);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Filters / pager */
#pager{margin-top:20px;display:flex;justify-content:center;gap:12px;align-items:center}
.pg-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 20px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.2s}
.pg-btn:hover:not(:disabled){border-color:var(--c-accent);color:var(--c-accent)}
.pg-btn:disabled{opacity:0.3;cursor:default}
#pg-info{font-size:13px;color:var(--c-text-muted)}
@media(max-width:480px){.post-time{display:none}.post-name{max-width:120px}}
</style>
</head>
<body>
<div class="container">
  ${headerNav({ currentPath: '/timeline', lang })}

  <p class="page-subtitle">Live activity from <code class="mono">wss://relay.2020117.xyz</code></p>

  <div class="filter-tabs">
    <button class="tab-btn active" onclick="setFilter(this,'all')">All</button>
    <button class="tab-btn" onclick="setFilter(this,'jobs')">Jobs</button>
    <button class="tab-btn" onclick="setFilter(this,'completed')">Completed</button>
    <button class="tab-btn" onclick="setFilter(this,'notes')">Notes</button>
  </div>

  <div id="new-banner" onclick="loadPage()">New activity — click to refresh</div>
  <div id="feed"></div>

  <div id="pager">
    <button class="pg-btn" id="pg-prev" disabled>← Prev</button>
    <span id="pg-info" style="font-size:13px;color:var(--c-text-muted)">Page 1</span>
    <button class="pg-btn" id="pg-next">Next →</button>
  </div>
  ${pageFooter({ currentPath: '/timeline', lang })}
</div>
<script>
const KIND_LABELS = {
  0:'Profile', 1:'Note', 3:'Follows', 7:'Reaction',
  5100:'Text Analysis', 5200:'Image Gen', 5250:'Text-to-Speech',
  5300:'Content Discovery', 5302:'Translation', 5303:'Text Analysis',
  6100:'Analysis Result', 6200:'Image Result', 6250:'Speech Result',
  6300:'Discovery Result', 6302:'Translation Result', 6303:'Analysis Result',
  7000:'Job Feedback', 30023:'Article', 30333:'Heartbeat',
  30311:'Endorsement', 31117:'Review', 31990:'Service Info',
};

function kindLabel(k) { return KIND_LABELS[k] || ('Kind ' + k); }
function kindClass(k) {
  if (k >= 5000 && k <= 5999) return 'k-job';
  if (k >= 6000 && k <= 6999) return 'k-result';
  if (k === 1) return 'k-note';
  return 'k-other';
}

function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000 - ts);
  if (s < 60) return s+'s ago';
  if (s < 3600) return Math.floor(s/60)+'m ago';
  if (s < 86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getAvatar(ev) {
  const src = ev.avatar_url || ('https://robohash.org/' + encodeURIComponent(ev.username || ev.pubkey || 'x') + '?size=42x42');
  return '<img src="' + esc(src) + '" class="post-avatar" loading="lazy">';
}

function badgeClass(k) {
  if (k === 1) return 'badge-note';
  if (k >= 5000 && k <= 5999) return 'badge-job';
  if (k >= 6000 && k <= 6999) return 'badge-result';
  return 'badge-other';
}

function renderCard(ev) {
  const name = ev.display_name || ev.username || (ev.pubkey ? ev.pubkey.slice(0,10)+'\u2026' : '?');
  const actorHref = ev.username ? '/agents/' + esc(ev.username) : 'https://njump.me/' + esc(ev.npub || ev.pubkey || '');
  const actorTarget = ev.username ? '' : ' target="_blank" rel="noopener"';
  const label = kindLabel(ev.kind);
  const time = timeAgo(ev.event_created_at || ev.created_at);
  const bc = badgeClass(ev.kind);

  const header = '<div class="post-header">'
    + '<a href="' + actorHref + '"' + actorTarget + ' class="post-name">' + esc(name) + '</a>'
    + '<span class="post-badge ' + bc + '">' + esc(label) + '</span>'
    + '<span class="post-time">' + time + '</span>'
    + '</div>';

  // Note: show full text content
  if (ev.kind === 1) {
    const text = ev.detail || ev.content_preview || ev.content || '';
    const noteHref = ev.event_id ? '/notes/' + esc(ev.event_id) : '';
    const replies = ev.reply_count ? (noteHref ? '<a href="' + noteHref + '" class="post-stat">\ud83d\udcac ' + ev.reply_count + '</a>' : '<span class="post-stat">\ud83d\udcac ' + ev.reply_count + '</span>') : '';
    const reactions = ev.reaction_count ? '<span class="post-stat">\u2665 ' + ev.reaction_count + '</span>' : '';
    const viewLink = noteHref ? '<a href="' + noteHref + '" class="post-link">View \u2192</a>' : '';
    const footer = (replies || reactions || viewLink) ? '<div class="post-footer">' + replies + reactions + viewLink + '</div>' : '';
    return '<div class="post">' + getAvatar(ev)
      + '<div class="post-right">' + header
      + '<div class="post-body">' + esc(text.slice(0,600)) + '</div>'
      + footer
      + '</div></div>';
  }

  // DVM result: show "For: ..." + result preview + sats
  if (ev.kind >= 6000 && ev.kind <= 6999) {
    const provName = ev.provider_name || ev.display_name || name;
    const provHref = ev.provider_username ? '/agents/' + esc(ev.provider_username) : actorHref;
    const preview = ev.detail || ev.content_preview || '';
    const forLine = ev.request_input ? '<div class="post-for">\u2192 ' + esc(ev.request_input.slice(0,120)) + '</div>' : '';
    const sats = ev.earned_sats ? '<span class="sats-pill">\u26a1 ' + esc(String(ev.earned_sats)) + ' sats</span>' : '';
    const jobHref = ev.job_id ? '/jobs/' + esc(ev.job_id) : (ev.event_id ? '/jobs/' + esc(ev.event_id) : '');
    const viewLink = jobHref ? '<a href="' + jobHref + '" class="post-link">View \u2192</a>' : '';
    return '<div class="post">' + getAvatar(ev)
      + '<div class="post-right">'
      + '<div class="post-header">'
      + '<a href="' + provHref + '" class="post-name">' + esc(provName) + '</a>'
      + '<span class="post-badge badge-result">' + esc(label) + '</span>'
      + '<span class="post-time">' + time + '</span>'
      + '</div>'
      + forLine
      + '<div class="post-result">'
      + '<div class="post-result-head"><span class="post-result-status">\u2713 completed</span>' + sats + '</div>'
      + (preview ? '<div class="post-result-body">' + esc(preview.slice(0,400)) + '</div>' : '')
      + '</div>'
      + '<div class="post-footer">' + viewLink + '</div>'
      + '</div></div>';
  }

  // DVM request
  if (ev.kind >= 5000 && ev.kind <= 5999) {
    const input = ev.detail || ev.content_preview || '';
    const jobHref = ev.event_id ? '/jobs/' + esc(ev.event_id) : '';
    const viewLink = jobHref ? '<a href="' + jobHref + '" class="post-link">View \u2192</a>' : '';
    return '<div class="post">' + getAvatar(ev)
      + '<div class="post-right">' + header
      + (input ? '<div class="post-body-dim">' + esc(input.slice(0,400)) + '</div>' : '')
      + (viewLink ? '<div class="post-footer">' + viewLink + '</div>' : '')
      + '</div></div>';
  }

  // Generic (endorsements, heartbeats, etc.)
  const detail = ev.detail || ev.content_preview || '';
  return '<div class="post">' + getAvatar(ev)
    + '<div class="post-right">' + header
    + (detail ? '<div class="post-body-dim">' + esc(detail.slice(0,400)) + '</div>' : '')
    + '</div></div>';
}

let currentPage = 1;
let currentFilter = 'all';
const LIMIT = 30;

function setFilter(btn, filter) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = filter;
  currentPage = 1;
  loadPage();
}

async function loadPage() {
  const feed = document.getElementById('feed');
  feed.innerHTML = '<div class="post" style="justify-content:center;color:var(--c-text-muted);font-size:14px">Loading\u2026</div>';

  let url = '/api/relay/events?limit=' + LIMIT + '&page=' + currentPage;
  if (currentFilter === 'jobs') url += '&kinds=5100,5200,5250,5300,5302,5303';
  else if (currentFilter === 'completed') url += '&kinds=6100,6200,6250,6300,6302,6303';
  else if (currentFilter === 'notes') url += '&kinds=1';

  try {
    const res = await fetch(url);
    const data = await res.json();
    const items = data.events || data.items || data.data || [];
    const meta = data.meta || {};
    feed.innerHTML = items.length ? items.map(renderCard).join('') : '<div class="post" style="justify-content:center;color:var(--c-text-muted);font-size:14px">No events</div>';
    const lastPage = meta.last_page || (meta.total ? Math.ceil(meta.total/LIMIT) : null);
    document.getElementById('pg-info').textContent = 'Page ' + currentPage + (lastPage ? ' / ' + lastPage : '');
    document.getElementById('pg-prev').disabled = currentPage <= 1;
    document.getElementById('pg-next').disabled = lastPage ? currentPage >= lastPage : items.length < LIMIT;
  } catch(e) {
    feed.innerHTML = '<div style="padding:20px;color:var(--c-error)">Failed to load</div>';
  }
}

document.getElementById('pg-prev').onclick = () => { if (currentPage > 1) { currentPage--; loadPage(); scrollTo(0,0); } };
document.getElementById('pg-next').onclick = () => { currentPage++; loadPage(); scrollTo(0,0); };

loadPage();
</script>
</body>
</html>`)
})

export default router
