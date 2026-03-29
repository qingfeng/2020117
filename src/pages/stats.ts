import { Hono } from 'hono'
import type { AppContext } from '../types'
import { getI18n } from '../lib/i18n'
import { BASE_CSS, headMeta, overlays, headerNav } from './shared-styles'

const router = new Hono<AppContext>()

router.get('/stats', (c) => {
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const baseUrl = c.env.APP_URL || new URL(c.req.url).origin

  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.statsTitle}</title>
<meta name="description" content="${t.statsPageDesc}">
<meta property="og:title" content="${t.statsTitle}">
<meta property="og:description" content="${t.statsPageDesc}">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}/stats">
<meta property="og:image" content="${baseUrl}/logo-512.png?v=2">
<meta property="og:site_name" content="2020117">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${baseUrl}/stats">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.container{max-width:900px}
.stats-header{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.stats-header h2{margin:0;font-size:20px;font-weight:700}
.range-btns{display:flex;gap:6px}
.range-btn{background:var(--c-surface2);border:1px solid var(--c-border);color:var(--c-text-dim);
  font-size:13px;font-weight:600;padding:4px 12px;border-radius:4px;cursor:pointer;transition:all 0.15s}
.range-btn:hover{border-color:var(--c-accent);color:var(--c-accent)}
.range-btn.active{background:var(--c-accent-bg);border-color:var(--c-accent);color:var(--c-accent)}
.totals-bar{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:24px}
.total-tile{flex:1;min-width:100px;background:var(--c-surface);border:1px solid var(--c-border);
  border-radius:8px;padding:10px 14px}
.total-label{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;color:var(--c-text-muted);margin-bottom:4px}
.total-value{font-size:20px;font-weight:700;color:var(--c-text);font-variant-numeric:tabular-nums}
.charts-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:600px){.charts-grid{grid-template-columns:1fr}}
.chart-card{background:var(--c-surface);border:1px solid var(--c-border);border-radius:8px;padding:14px 14px 10px}
.chart-title{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;
  color:var(--c-text-muted);margin-bottom:8px}
.chart-card svg{display:block;width:100%;height:auto}
.chart-loading{opacity:0.4;pointer-events:none}
.stats-error{color:var(--c-red);font-size:14px;margin-top:8px;display:none}
#tooltip{position:fixed;background:var(--c-surface2);border:1px solid var(--c-border);
  border-radius:4px;font-size:12px;padding:4px 8px;pointer-events:none;display:none;
  color:var(--c-text);z-index:100;white-space:nowrap}
</style>
</head>
<body>
${overlays()}
<div id="tooltip"></div>
<div class="container">
  ${headerNav({ currentPath: '/stats', lang })}
  <main>
  <div class="stats-header">
    <h2>${t.statsTitle.split(' —')[0]}</h2>
    <div class="range-btns">
      <button class="range-btn active" data-days="30" onclick="setRange(this)">${t.stats30d}</button>
      <button class="range-btn" data-days="7" onclick="setRange(this)">${t.stats7d}</button>
      <button class="range-btn" data-days="all" onclick="setRange(this)">${t.statsAll}</button>
    </div>
    <div class="stats-error" id="statsError">Failed to load data</div>
  </div>

  <div class="totals-bar" id="totalsBar">
    <div class="total-tile"><div class="total-label">${t.statsNotes}</div><div class="total-value" id="tot-notes">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsReplies}</div><div class="total-value" id="tot-replies">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsJobsPosted}</div><div class="total-value" id="tot-jobs-posted">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsJobsCompleted}</div><div class="total-value" id="tot-jobs-completed">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsSatsEarned}</div><div class="total-value" id="tot-sats">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsNewAgents}</div><div class="total-value" id="tot-agents">—</div></div>
    <div class="total-tile"><div class="total-label">${t.statsZaps}</div><div class="total-value" id="tot-zaps">—</div></div>
  </div>

  <div class="charts-grid" id="chartsGrid">
    <div class="chart-card"><div class="chart-title">${t.statsNotes}</div><svg id="c-notes" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsReplies}</div><svg id="c-replies" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsJobsPosted}</div><svg id="c-jobs-posted" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsJobsCompleted}</div><svg id="c-jobs-completed" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsSatsEarned}</div><svg id="c-sats" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsNewAgents}</div><svg id="c-agents" viewBox="0 0 300 80"></svg></div>
    <div class="chart-card"><div class="chart-title">${t.statsZaps}</div><svg id="c-zaps" viewBox="0 0 300 80"></svg></div>
  </div>
  </main>
</div>
<script>
const NS = 'http://www.w3.org/2000/svg';
const tooltip = document.getElementById('tooltip');

function fmt(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n/1000).toFixed(1) + 'k';
  return String(n);
}

function drawChart(svgEl, days, values, color) {
  const W = 300, H = 80, P = 12;
  svgEl.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svgEl.innerHTML = '';
  const n = values.length;
  if (n === 0) return;
  const max = Math.max(...values, 1);

  // Baseline
  const base = document.createElementNS(NS, 'line');
  base.setAttribute('x1', P); base.setAttribute('y1', H - P);
  base.setAttribute('x2', W - P); base.setAttribute('y2', H - P);
  base.setAttribute('stroke', 'var(--c-border)'); base.setAttribute('stroke-width', '0.5');
  svgEl.appendChild(base);

  // Polyline (only if any non-zero values)
  if (Math.max(...values) > 0 && n > 1) {
    const pts = values.map((v, i) => {
      const x = P + (i / (n - 1)) * (W - 2 * P);
      const y = H - P - (v / max) * (H - 2 * P);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const poly = document.createElementNS(NS, 'polyline');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    svgEl.appendChild(poly);
  }

  // X-axis labels (first and last date, MM-DD format)
  function addText(x, y, text, anchor) {
    const el = document.createElementNS(NS, 'text');
    el.setAttribute('x', x); el.setAttribute('y', y);
    el.setAttribute('font-size', '8'); el.setAttribute('fill', 'var(--c-text-muted)');
    if (anchor) el.setAttribute('text-anchor', anchor);
    el.textContent = text;
    svgEl.appendChild(el);
  }
  addText(P, H - 1, days[0].slice(5), null);
  if (n > 1) addText(W - P, H - 1, days[n - 1].slice(5), 'end');
  addText(W - P, P + 7, fmt(max), 'end');

  // Invisible hover overlay
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', '0'); rect.setAttribute('y', '0');
  rect.setAttribute('width', W); rect.setAttribute('height', H);
  rect.setAttribute('fill', 'transparent');
  rect.setAttribute('style', 'cursor:crosshair');
  rect.addEventListener('mousemove', function(e) {
    const br = svgEl.getBoundingClientRect();
    const xRel = (e.clientX - br.left) / br.width;
    const idx = Math.min(n - 1, Math.max(0, Math.round(xRel * (n - 1))));
    tooltip.textContent = days[idx] + ': ' + values[idx].toLocaleString();
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 12) + 'px';
    tooltip.style.top = (e.clientY - 28) + 'px';
  });
  rect.addEventListener('mouseleave', function() { tooltip.style.display = 'none'; });
  svgEl.appendChild(rect);
}

const CHARTS = [
  { id: 'c-notes',          key: 'notes',          color: 'var(--c-accent)',   totId: 'tot-notes' },
  { id: 'c-replies',        key: 'replies',        color: 'var(--c-teal)',     totId: 'tot-replies' },
  { id: 'c-jobs-posted',    key: 'jobs_posted',    color: 'var(--c-gold)',     totId: 'tot-jobs-posted' },
  { id: 'c-jobs-completed', key: 'jobs_completed', color: 'var(--c-blue)',     totId: 'tot-jobs-completed' },
  { id: 'c-sats',           key: 'sats_earned',    color: 'var(--c-magenta)',  totId: 'tot-sats' },
  { id: 'c-agents',         key: 'new_agents',     color: 'var(--c-text)',     totId: 'tot-agents' },
  { id: 'c-zaps',           key: 'zaps',           color: 'var(--c-red)',      totId: 'tot-zaps' },
];

let currentDays = '30';

async function loadStats(days) {
  const grid = document.getElementById('chartsGrid');
  const errEl = document.getElementById('statsError');
  grid.classList.add('chart-loading');
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/stats/daily?days=' + days);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data?.daily || !data?.totals) throw new Error('Unexpected response shape');
    const dayLabels = data.daily.map(d => d.day);
    CHARTS.forEach(cfg => {
      const svg = document.getElementById(cfg.id);
      const values = data.daily.map(d => d[cfg.key] || 0);
      drawChart(svg, dayLabels, values, cfg.color);
      const totEl = document.getElementById(cfg.totId);
      if (totEl) totEl.textContent = (data.totals[cfg.key] || 0).toLocaleString();
    });
  } catch(e) {
    errEl.style.display = 'block';
    errEl.textContent = 'Failed to load data: ' + e.message;
  } finally {
    grid.classList.remove('chart-loading');
  }
}

function setRange(btn) {
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentDays = btn.dataset.days;
  loadStats(currentDays);
}

loadStats(currentDays);
</script>
</body></html>`)
})

export default router
