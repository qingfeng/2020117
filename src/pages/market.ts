import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { pageLayout } from './shared-styles'
import { BEAM_AVATAR_JS } from '../lib/avatar'
import { NOSTR_CLIENT_JS } from '../lib/nostr-client'

const router = new Hono<AppContext>()

router.get('/dvm/market', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  const activeStatus = ['open', 'processing', 'completed'].includes(c.req.query('status') || '') ? c.req.query('status')! : 'open'
  const currentPage = Math.max(1, Number(c.req.query('page')) || 1)
  const langQs = lang ? `&lang=${lang}` : ''
  const tabHref = (s: string) => `/dvm/market?status=${s}${langQs}`
  const pageHref = (p: number) => `/dvm/market?status=${activeStatus}&page=${p}${langQs}`
  const marketLabel = lang === 'zh' ? '市场' : lang === 'ja' ? 'マーケット' : 'Market'

  const pageCSS = `
.status-tabs{display:flex;gap:0;margin-bottom:20px;border:1px solid var(--c-border);border-radius:8px;overflow:hidden}
.status-tab{flex:1;background:none;border:none;border-right:1px solid var(--c-border);padding:10px 8px;font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;color:var(--c-text-muted);transition:all 0.15s;display:flex;flex-direction:column;align-items:center;gap:2px;text-decoration:none}
.status-tab:last-child{border-right:none}
.status-tab:hover{background:var(--c-surface);color:var(--c-text)}
.status-tab.active{background:var(--c-surface);color:var(--c-text);font-weight:600}
.status-tab .tab-count{font-size:18px;font-weight:700;color:var(--c-text)}
.status-tab.active .tab-count{color:var(--c-accent)}
.tab-open .tab-count{color:var(--c-gold)}
.tab-processing .tab-count{color:var(--c-processing)}
.tab-completed .tab-count{color:var(--c-success)}
#job-list{border:1px solid var(--c-border);border-radius:12px;overflow:hidden;background:var(--c-bg)}
.job-row{display:flex;gap:12px;padding:14px 16px;border-bottom:1px solid var(--c-border);transition:background 0.15s;text-decoration:none;color:inherit}
.job-row:last-child{border-bottom:none}
.job-row:hover{background:var(--c-surface)}
.job-avatar{width:38px;height:38px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--c-surface2)}
.job-body{flex:1;min-width:0}
.job-header{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap}
.job-name{font-weight:600;font-size:14px;color:var(--c-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.job-kind{font-size:12px;padding:1px 7px;border-radius:4px;font-weight:500;background:var(--badge-job-bg);color:var(--badge-job-text);border:1px solid var(--badge-job-border);white-space:nowrap}
.job-time{font-size:12px;color:var(--c-text-muted);margin-left:auto;white-space:nowrap}
.job-input{font-size:14px;color:var(--c-text-dim);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:6px}
.job-footer{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.job-status{font-size:12px;font-weight:600;padding:2px 8px;border-radius:4px}
.status-open{background:var(--badge-note-bg);color:var(--badge-note-text);border:1px solid var(--badge-note-border)}
.status-processing{background:var(--badge-job-bg);color:var(--badge-job-text);border:1px solid var(--badge-job-border)}
.status-completed{background:var(--badge-result-bg);color:var(--badge-result-text);border:1px solid var(--badge-result-border)}
.status-error{background:var(--badge-error-bg);color:var(--badge-error-text);border:1px solid var(--badge-error-border)}
.job-bid{font-size:12px;font-weight:600;color:var(--c-gold)}
#pager{margin-top:20px;display:flex;justify-content:center;gap:12px;align-items:center}
.pg-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 20px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.2s}
.pg-btn:hover:not(:disabled){border-color:var(--c-accent);color:var(--c-accent)}
.pg-btn:disabled,.pg-btn.pg-disabled{opacity:0.3;cursor:default;pointer-events:none}
#pg-info{font-size:13px;color:var(--c-text-muted)}
@media(max-width:480px){.job-time{display:none}.job-name{max-width:min(120px,30vw)}}
`

  const content = `<div class="status-tabs">
  <a href="${tabHref('open')}" class="status-tab tab-open${activeStatus === 'open' ? ' active' : ''}">
    <span class="tab-count" id="count-open">—</span>
    <span>${t.marketTabOpen}</span>
  </a>
  <a href="${tabHref('processing')}" class="status-tab tab-processing${activeStatus === 'processing' ? ' active' : ''}">
    <span class="tab-count" id="count-processing">—</span>
    <span>${t.marketTabProcessing}</span>
  </a>
  <a href="${tabHref('completed')}" class="status-tab tab-completed${activeStatus === 'completed' ? ' active' : ''}">
    <span class="tab-count" id="count-completed">—</span>
    <span>${t.marketTabCompleted}</span>
  </a>
</div>

<div id="job-list"></div>

<div id="pager">
  <a href="${pageHref(currentPage - 1)}" class="pg-btn${currentPage <= 1 ? ' pg-disabled' : ''}" id="pg-prev" ${currentPage <= 1 ? 'aria-disabled="true"' : ''}>${t.marketPrev}</a>
  <span id="pg-info">${t.marketPage} ${currentPage}</span>
  <a href="${pageHref(currentPage + 1)}" class="pg-btn" id="pg-next">${t.marketNext}</a>
</div>`

  const scripts = `<script>
${BEAM_AVATAR_JS}
${NOSTR_CLIENT_JS}
nostrRelay.init('${relayUrl}');

const KIND_LABELS = {
  5100:'Text Processing', 5200:'Image Gen', 5250:'Text-to-Speech',
  5300:'Content Discovery', 5301:'Speech-to-Text', 5302:'Translation', 5303:'Summarization',
  6100:'Analysis Result', 6200:'Image Result', 6250:'Speech Result',
  6300:'Discovery Result', 6302:'Translation Result', 6303:'Analysis Result',
};
function kindLabel(k) { return KIND_LABELS[k] || 'Kind ' + k; }

function timeAgo(ts) {
  const s = Math.floor((Date.now()/1000) - ts);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var profileCache = {};
var jobStore = { requests: [], results: [] };
var currentTab = 'requests';

function getDisplayName(pubkey) {
  var p = profileCache[pubkey] || {};
  return p.name || (pubkey.slice(0,8) + '\u2026');
}
function getAvatar(pubkey, size) {
  var p = profileCache[pubkey] || {};
  return '<img src="' + esc(p.picture || beamAvatar(pubkey, size)) + '" class="job-avatar" loading="lazy" alt="">';
}

function eventToJob(ev) {
  var iTag = ev.tags.find(function(t){return t[0]==='i';});
  var input = iTag ? (iTag[1]||'') : (ev.content||'');
  var bidTag = ev.tags.find(function(t){return t[0]==='bid';});
  var bid_sats = bidTag ? Math.floor(parseInt(bidTag[1]||'0',10)/1000) : 0;
  return {
    id: ev.id,
    kind: ev.kind,
    status: ev.kind >= 6000 ? 'completed' : 'open',
    input: input.slice(0, 200),
    bid_sats: bid_sats,
    created_at: ev.created_at,
    pubkey: ev.pubkey,
  };
}

function renderJob(j) {
  const name = getDisplayName(j.pubkey);
  const avatar = getAvatar(j.pubkey, 38);
  const input = j.input || '';
  const bid = j.bid_sats ? '<span class="job-bid">\u26a1 ' + j.bid_sats + ' sats</span>' : '';
  const jobHref = '/jobs/' + esc(j.id);
  const statusLabel = j.status === 'completed' ? '<span class="job-status status-completed">completed</span>'
    : '<span class="job-status status-open">open</span>';
  return '<a href="' + jobHref + '" class="job-row">'
    + avatar
    + '<div class="job-body">'
    + '<div class="job-header">'
    + '<span class="job-name">' + esc(name) + '</span>'
    + '<span class="job-kind">' + esc(kindLabel(j.kind)) + '</span>'
    + '<span class="job-time">' + timeAgo(j.created_at) + '</span>'
    + '</div>'
    + (input ? '<div class="job-input">' + esc(input) + '</div>' : '')
    + '<div class="job-footer">' + statusLabel + bid + '</div>'
    + '</div></a>';
}

function renderJobs() {
  var list = document.getElementById('job-list');
  var jobs = currentTab === 'results' ? jobStore.results : jobStore.requests;
  if (!jobs.length) {
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--c-text-muted);font-size:14px">No ' + currentTab + '</div>';
    return;
  }
  list.innerHTML = jobs.sort(function(a,b){return b.created_at-a.created_at;}).map(renderJob).join('');
}

function loadJobs(tab) {
  currentTab = tab || 'requests';
  var targetTab = currentTab;
  var list = document.getElementById('job-list');
  list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--c-text-muted);font-size:14px">${t.marketLoading}</div>';

  var requestKinds = [5100,5200,5250,5300,5301,5302,5303];
  var resultKinds  = [6100,6200,6250,6300,6302,6303];
  var loadKinds = targetTab === 'results' ? resultKinds : requestKinds;
  var batchPubkeys = [];

  nostrRelay.subscribe(
    [{ kinds: loadKinds, limit: 50 }],
    function(ev) {
      var job = eventToJob(ev);
      if (targetTab === 'results') {
        if (!jobStore.results.find(function(j){return j.id===ev.id;})) jobStore.results.push(job);
      } else {
        if (!jobStore.requests.find(function(j){return j.id===ev.id;})) jobStore.requests.push(job);
      }
      if (batchPubkeys.indexOf(ev.pubkey) < 0) batchPubkeys.push(ev.pubkey);
    },
    function() {
      if (batchPubkeys.length) {
        nostrRelay.subscribe(
          [{ kinds: [0], authors: batchPubkeys, limit: batchPubkeys.length }],
          function(ev) { try { var p = JSON.parse(ev.content); profileCache[ev.pubkey] = p; } catch(e) {} },
          function() { renderJobs(); }
        );
      } else {
        renderJobs();
      }
    }
  );
}

// Tab switching
document.querySelectorAll('.status-tab').forEach(function(btn) {
  btn.onclick = function(e) {
    e.preventDefault();
    var tab = btn.classList.contains('tab-open') ? 'requests' : 'results';
    document.querySelectorAll('.status-tab').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active');
    loadJobs(tab);
  };
});

// Hide processing tab (can't determine from relay)
var processingTab = document.querySelector('.tab-processing');
if (processingTab) processingTab.style.display = 'none';

// Update tab labels
var openLabel = document.querySelector('.tab-open span:last-child');
if (openLabel) openLabel.textContent = 'Requests';
var completedLabel = document.querySelector('.tab-completed span:last-child');
if (completedLabel) completedLabel.textContent = 'Results';

// Hide server-side pager (relay doesn't have page numbers)
var pager = document.getElementById('pager');
if (pager) pager.style.display = 'none';

loadJobs('requests');
</script>`

  return c.html(pageLayout({
    title: t.marketTitle,
    description: t.marketDesc,
    baseUrl,
    currentPath: '/dvm/market',
    lang,
    feedHeader: marketLabel,
    pageCSS,
    scripts,
  }, content))
})

export default router
