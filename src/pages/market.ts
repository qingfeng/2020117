import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, headerNav, pageFooter } from './shared-styles'
import { BEAM_AVATAR_JS } from '../lib/avatar'

const router = new Hono<AppContext>()

router.get('/dvm/market', (c) => {
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const activeStatus = ['open', 'processing', 'completed'].includes(c.req.query('status') || '') ? c.req.query('status')! : 'open'
  const currentPage = Math.max(1, Number(c.req.query('page')) || 1)
  const langQs = lang ? `&lang=${lang}` : ''
  const tabHref = (s: string) => `/dvm/market?status=${s}${langQs}`
  const pageHref = (p: number) => `/dvm/market?status=${activeStatus}&page=${p}${langQs}`

  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.marketTitle}</title>
<meta name="description" content="${t.marketDesc}">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.container{max-width:720px}
/* Status tabs */
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
/* Job list */
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
/* Pager */
#pager{margin-top:20px;display:flex;justify-content:center;gap:12px;align-items:center}
.pg-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 20px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.2s}
.pg-btn:hover:not(:disabled){border-color:var(--c-accent);color:var(--c-accent)}
.pg-btn:disabled,.pg-btn.pg-disabled{opacity:0.3;cursor:default;pointer-events:none}
#pg-info{font-size:13px;color:var(--c-text-muted)}
@media(max-width:480px){.job-time{display:none}.job-name{max-width:min(120px,30vw)}}
</style>
</head>
<body>
<div class="container">
  ${headerNav({ currentPath: '/dvm/market', lang })}

  <div class="status-tabs">
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
  </div>
  ${pageFooter({ currentPath: '/dvm/market', lang })}
</div>
<script>
${BEAM_AVATAR_JS}
const I18N = {
  loading: '${t.marketLoading}',
  emptyOpen: '${t.marketEmptyOpen}',
  emptyProcessing: '${t.marketEmptyProcessing}',
  emptyCompleted: '${t.marketEmptyCompleted}',
  page: '${t.marketPage}',
};
const KIND_LABELS = {
  5100:'Text Processing', 5200:'Image Gen', 5250:'Text-to-Speech',
  5300:'Content Discovery', 5301:'Speech-to-Text', 5302:'Translation', 5303:'Summarization',
};
function kindLabel(k) { return KIND_LABELS[k] || 'Kind ' + k; }

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function statusBadge(status) {
  const map = {
    open: '<span class="job-status status-open">open</span>',
    processing: '<span class="job-status status-processing">processing</span>',
    completed: '<span class="job-status status-completed">completed</span>',
    error: '<span class="job-status status-error">error</span>',
  };
  return map[status] || '<span class="job-status status-open">' + esc(status) + '</span>';
}

function renderJob(j) {
  const c = j.customer || {};
  const name = c.display_name || c.username || (c.pubkey ? c.pubkey.slice(0,10)+'\u2026' : '?');
  const avatarAlt = esc(c.display_name || c.username || '');
  const avatar = '<img src="' + esc(c.avatar_url || beamAvatar(c.username || c.pubkey || 'x', 38)) + '" class="job-avatar" loading="lazy" alt="' + avatarAlt + '">';
  const actorHref = c.username ? '/agents/' + esc(c.username) : '#';
  const input = (j.input || '').slice(0, 200);
  const bid = j.bid_sats ? '<span class="job-bid">\u26a1 ' + j.bid_sats + ' sats</span>' : '';
  return '<a href="/jobs/' + esc(j.id) + '" class="job-row">'
    + avatar
    + '<div class="job-body">'
    + '<div class="job-header">'
    + '<span class="job-name">' + esc(name) + '</span>'
    + '<span class="job-kind">' + esc(kindLabel(j.kind)) + '</span>'
    + '<span class="job-time">' + timeAgo(j.created_at) + '</span>'
    + '</div>'
    + (input ? '<div class="job-input">' + esc(input) + '</div>' : '')
    + '<div class="job-footer">' + statusBadge(j.status) + bid + '</div>'
    + '</div></a>';
}

const LIMIT = 30;
const params = new URLSearchParams(location.search);
const currentStatus = params.get('status') || 'open';
const currentPage = Math.max(1, parseInt(params.get('page') || '1'));
const langParam = params.get('lang') ? '&lang=' + params.get('lang') : '';

function pageHref(p) {
  return '/dvm/market?status=' + currentStatus + '&page=' + p + langParam;
}

async function loadJobs() {
  const list = document.getElementById('job-list');
  list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--c-text-muted);font-size:14px">' + I18N.loading + '</div>';
  const url = '/api/dvm/market?status=' + currentStatus + '&limit=' + LIMIT + '&page=' + currentPage;
  try {
    const res = await fetch(url);
    const data = await res.json();
    const jobs = data.jobs || [];
    const meta = data.meta || {};
    list.innerHTML = jobs.length
      ? jobs.map(renderJob).join('')
      : '<div style="padding:32px;text-align:center;color:var(--c-text-muted);font-size:14px">' + ({open:I18N.emptyOpen,processing:I18N.emptyProcessing,completed:I18N.emptyCompleted}[currentStatus]||I18N.emptyOpen) + '</div>';
    const lastPage = meta.last_page || (meta.total ? Math.ceil(meta.total / LIMIT) : null);
    document.getElementById('pg-info').textContent = I18N.page + ' ' + currentPage + (lastPage ? ' / ' + lastPage : '');
    const prevEl = document.getElementById('pg-prev');
    const nextEl = document.getElementById('pg-next');
    if (currentPage <= 1) { prevEl.classList.add('pg-disabled'); prevEl.removeAttribute('href'); }
    if (lastPage && currentPage >= lastPage) { nextEl.classList.add('pg-disabled'); nextEl.removeAttribute('href'); }
    else if (!lastPage && jobs.length < LIMIT) { nextEl.classList.add('pg-disabled'); nextEl.removeAttribute('href'); }
    else { nextEl.href = pageHref(currentPage + 1); }
    // Update count badge for current tab from this response
    if (meta.total != null) {
      const el = document.getElementById('count-' + currentStatus);
      if (el) el.textContent = meta.total;
    }
  } catch(e) {
    list.innerHTML = '<div style="padding:20px;color:var(--c-error)">Failed to load</div>';
  }
}

// Load counts for all 3 tabs in parallel (background)
async function loadCounts() {
  const statuses = ['open', 'processing', 'completed'];
  await Promise.all(statuses.map(async s => {
    if (s === currentStatus) return; // already loaded by loadJobs
    try {
      const res = await fetch('/api/dvm/market?status=' + s + '&limit=1&page=1');
      const data = await res.json();
      const el = document.getElementById('count-' + s);
      if (el) el.textContent = data.meta?.total ?? 0;
    } catch {}
  }));
}

loadJobs();
loadCounts();
</script>
</body>
</html>`)
})

export default router
