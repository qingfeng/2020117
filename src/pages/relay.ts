import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav, pageFooter, NOTE_RENDER_JS } from './shared-styles'
import { BEAM_AVATAR_JS } from '../lib/avatar'
import { NOSTR_CLIENT_JS } from '../lib/nostr-client'

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
  const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
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
.post-body{font-size:15px;color:var(--c-text);line-height:1.55;margin-bottom:6px;white-space:normal;word-break:break-word;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
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
${BEAM_AVATAR_JS}
${NOTE_RENDER_JS}
${NOSTR_CLIENT_JS}

// Initialize relay
var RELAY_URL = '${relayUrl}';
nostrRelay.init(RELAY_URL);

const KIND_LABELS = {
  0:'Profile', 1:'Note', 3:'Follows', 7:'Reaction',
  5100:'Text Analysis', 5200:'Image Gen', 5250:'Text-to-Speech',
  5300:'Content Discovery', 5301:'Speech-to-Text', 5302:'Translation', 5303:'Text Analysis',
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
function badgeClass(k) {
  if (k === 1) return 'badge-note';
  if (k >= 5000 && k <= 5999) return 'badge-job';
  if (k >= 6000 && k <= 6999) return 'badge-result';
  return 'badge-other';
}

// Profile cache: pubkey → {name, picture}
var profileCache = {};
function getAvatar(pubkey) {
  var prof = profileCache[pubkey] || {};
  var src = prof.picture || beamAvatar(pubkey, 42);
  return '<img src="' + esc(src) + '" class="post-avatar" loading="lazy">';
}
function getDisplayName(pubkey) {
  var prof = profileCache[pubkey] || {};
  return prof.name || (pubkey.slice(0,10) + '\u2026');
}

// Adapted renderCard — accepts raw Nostr event
function renderCard(ev) {
  const name = getDisplayName(ev.pubkey);
  const label = kindLabel(ev.kind);
  const time = timeAgo(ev.created_at);
  const bc = badgeClass(ev.kind);
  const noteHref = '/notes/' + esc(ev.id);
  const avatar = getAvatar(ev.pubkey);
  const header = '<div class="post-header">'
    + '<span class="post-name">' + esc(name) + '</span>'
    + '<span class="post-badge ' + bc + '">' + esc(label) + '</span>'
    + '<span class="post-time">' + time + '</span>'
    + '</div>';

  if (ev.kind === 1) {
    const text = ev.content || '';
    return '<div class="post">' + avatar
      + '<div class="post-right">' + header
      + renderNoteText(text, 600)
      + '<div class="post-footer"><a href="' + noteHref + '" class="post-link">View \u2192</a></div>'
      + '</div></div>';
  }
  if (ev.kind >= 6000 && ev.kind <= 6999) {
    const preview = (ev.content || '').slice(0, 400);
    const jobHref = '/jobs/' + esc(ev.id);
    return '<div class="post">' + avatar
      + '<div class="post-right">' + header
      + '<div class="post-result">'
      + '<div class="post-result-head"><span class="post-result-status">\u2713 result</span></div>'
      + (preview ? '<div class="post-result-body">' + esc(preview) + '</div>' : '')
      + '</div>'
      + '<div class="post-footer"><a href="' + jobHref + '" class="post-link">View \u2192</a></div>'
      + '</div></div>';
  }
  if (ev.kind >= 5000 && ev.kind <= 5999) {
    const iTag = ev.tags.find(function(t){return t[0]==='i';});
    const input = (iTag ? iTag[1] : ev.content || '').slice(0, 400);
    const jobHref = '/jobs/' + esc(ev.id);
    return '<div class="post">' + avatar
      + '<div class="post-right">' + header
      + (input ? '<div class="post-body-dim">' + esc(input) + '</div>' : '')
      + '<div class="post-footer"><a href="' + jobHref + '" class="post-link">View \u2192</a></div>'
      + '</div></div>';
  }
  const detail = (ev.content || '').slice(0, 400);
  return '<div class="post">' + avatar
    + '<div class="post-right">' + header
    + (detail ? '<div class="post-body-dim">' + esc(detail) + '</div>' : '')
    + '</div></div>';
}

const ALL_KINDS = [1,5100,5200,5250,5300,5301,5302,5303,6100,6200,6250,6300,6302,6303,7000];
const FILTER_KINDS = {
  all: ALL_KINDS,
  jobs: [5100,5200,5250,5300,5301,5302,5303],
  completed: [6100,6200,6250,6300,6302,6303],
  notes: [1],
};

var eventStore = [];
var currentFilter = 'all';
var oldestTs = null;

function setFilter(btn, filter) {
  document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
  btn.classList.add('active');
  currentFilter = filter;
  renderFeed();
}

function renderFeed() {
  var kinds = FILTER_KINDS[currentFilter];
  var filtered = eventStore.filter(function(ev){ return kinds.indexOf(ev.kind) >= 0; });
  var feed = document.getElementById('feed');
  if (!filtered.length) {
    feed.innerHTML = '<div class="post" style="justify-content:center;color:var(--c-text-muted);font-size:14px">No events</div>';
    return;
  }
  feed.innerHTML = filtered.map(renderCard).join('');
  document.getElementById('pg-info').textContent = filtered.length + ' events';
}

function loadInitial() {
  var feed = document.getElementById('feed');
  feed.innerHTML = '<div class="post" style="justify-content:center;color:var(--c-text-muted);font-size:14px">Loading\u2026</div>';
  var now = Math.floor(Date.now()/1000);
  var since = now - 7*86400;
  var batchPubkeys = [];

  nostrRelay.subscribe(
    [{ kinds: ALL_KINDS, limit: 50, since: since }],
    function(ev) {
      eventStore.push(ev);
      if (batchPubkeys.indexOf(ev.pubkey) < 0) batchPubkeys.push(ev.pubkey);
      if (!oldestTs || ev.created_at < oldestTs) oldestTs = ev.created_at;
    },
    function() {
      eventStore.sort(function(a,b){ return b.created_at - a.created_at; });
      if (batchPubkeys.length) {
        nostrRelay.subscribe(
          [{ kinds: [0], authors: batchPubkeys, limit: batchPubkeys.length }],
          function(ev) {
            try { var p = JSON.parse(ev.content); profileCache[ev.pubkey] = p; } catch {}
          },
          function() { renderFeed(); }
        );
      } else {
        renderFeed();
      }
    }
  );
}

function loadOlder() {
  if (!oldestTs) return;
  var moreBtn = document.getElementById('pg-next');
  if (moreBtn) moreBtn.disabled = true;
  var batchPubkeys = [];
  nostrRelay.subscribe(
    [{ kinds: ALL_KINDS, limit: 50, until: oldestTs - 1 }],
    function(ev) {
      if (!eventStore.find(function(e){return e.id===ev.id;})) {
        eventStore.push(ev);
        if (batchPubkeys.indexOf(ev.pubkey) < 0) batchPubkeys.push(ev.pubkey);
        if (!oldestTs || ev.created_at < oldestTs) oldestTs = ev.created_at;
      }
    },
    function() {
      eventStore.sort(function(a,b){ return b.created_at - a.created_at; });
      if (batchPubkeys.length) {
        nostrRelay.subscribe(
          [{ kinds: [0], authors: batchPubkeys, limit: batchPubkeys.length }],
          function(ev) { try { var p = JSON.parse(ev.content); profileCache[ev.pubkey] = p; } catch {} },
          function() { renderFeed(); if (moreBtn) moreBtn.disabled = false; }
        );
      } else {
        renderFeed();
        if (moreBtn) moreBtn.disabled = false;
      }
    }
  );
}

document.getElementById('pg-next').onclick = loadOlder;
document.getElementById('pg-prev').style.display = 'none';
loadInitial();
</script>
</body>
</html>`)
})

export default router
