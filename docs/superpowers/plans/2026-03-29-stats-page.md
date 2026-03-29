# Stats Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/stats` page with 7 SVG line charts (notes, replies, jobs posted, jobs completed, sats earned, new agents, zaps) and a 7d/30d/all time-range toggle.

**Architecture:** New `GET /api/stats/daily?days=7|30|all` endpoint in `src/routes/content.ts` runs 7 parallel D1 queries with server-side gap-filling. New SSR page `src/pages/stats.ts` renders the framework; client-side JS fetches the API and draws zero-dependency SVG charts.

**Tech Stack:** Cloudflare Workers, Hono SSR, D1 SQLite (raw prepared statements for GROUP BY), inline SVG via DOM API, existing CSS custom properties.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/i18n.ts` | Modify | Add 10 new i18n keys (en/zh/ja) |
| `src/routes/content.ts` | Modify | Add `GET /api/stats/daily` endpoint |
| `src/pages/shared-styles.ts` | Modify | Add Stats nav link |
| `src/index.ts` | Modify | Import + register stats page, add `/stats` to cache allowlist |
| `src/pages/stats.ts` | Create | SSR page shell + all client-side chart logic |

---

## Task 1: Add i18n keys

**Files:**
- Modify: `src/lib/i18n.ts`

The file has three locale objects. Find the `repAttestationsNote` key in each and insert the new stats keys after it.

> **Note:** `statsSatsEarned` already exists in all three locales (lines 62/202/339) — do NOT add it again.

- [ ] **Step 1: Add English keys** — after `repAttestationsNote: 'time-decayed · Kind 30085',` in the `en` block:

```typescript
    // stats page
    statsTitle: 'Stats — 2020117',
    statsPageDesc: 'Platform activity over time',
    stats7d: '7d',
    stats30d: '30d',
    statsAll: 'All',
    statsNotes: 'Notes',
    statsReplies: 'Replies',
    statsJobsPosted: 'Jobs Posted',
    statsJobsCompleted: 'Jobs Completed',
    statsNewAgents: 'New Agents',
    statsZaps: 'Zaps',
```

- [ ] **Step 2: Add Chinese keys** — after `repAttestationsNote: '时间衰减 · Kind 30085',` in the `zh` block:

```typescript
    // stats page
    statsTitle: '统计 — 2020117',
    statsPageDesc: '平台活动随时间变化',
    stats7d: '7天',
    stats30d: '30天',
    statsAll: '全部',
    statsNotes: '笔记',
    statsReplies: '回复',
    statsJobsPosted: '发布任务',
    statsJobsCompleted: '完成任务',
    statsNewAgents: '新注册',
    statsZaps: 'Zap',
```

- [ ] **Step 3: Add Japanese keys** — after `repAttestationsNote: '時間減衰 · Kind 30085',` in the `ja` block:

```typescript
    // stats page
    statsTitle: '統計 — 2020117',
    statsPageDesc: '時間経過によるプラットフォーム活動',
    stats7d: '7日',
    stats30d: '30日',
    statsAll: '全期間',
    statsNotes: 'ノート',
    statsReplies: '返信',
    statsJobsPosted: 'ジョブ投稿',
    statsJobsCompleted: 'ジョブ完了',
    statsNewAgents: '新規登録',
    statsZaps: 'Zap',
```

- [ ] **Step 4: Verify — check no duplicate keys**

```bash
grep -n "statsTitle\|stats7d\|statsNotes" src/lib/i18n.ts
```

Expected: exactly 3 occurrences of each (one per locale).

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n.ts
git commit -m "feat(stats): add i18n keys for stats page (en/zh/ja)"
```

---

## Task 2: Add `/api/stats/daily` endpoint

**Files:**
- Modify: `src/routes/content.ts` — append after the existing `/stats` handler (around line 38)

This endpoint uses raw D1 prepared statements (not Drizzle ORM) because GROUP BY aggregations are cleaner with raw SQL. The D1 binding is `c.env.DB`.

**Timestamp note:**
- `relay_event.event_created_at` = Unix **seconds** → `date(col, 'unixepoch')`
- `dvm_job.created_at`, `dvm_job.updated_at`, `user.created_at` = Unix **milliseconds** (Drizzle `mode:'timestamp'`) → `date(col/1000, 'unixepoch')`

- [ ] **Step 1: Add the endpoint** — insert after line 38 (after the closing `})` of `content.get('/stats', ...)`):

```typescript
// GET /api/stats/daily?days=7|30|all — per-day activity breakdown
content.get('/stats/daily', async (c) => {
  const daysParam = c.req.query('days') || '30'
  const nDays = daysParam === 'all' ? 90 : (daysParam === '7' ? 7 : 30)
  const nowSec = Math.floor(Date.now() / 1000)
  const sinceS = nowSec - nDays * 86400          // relay_event uses seconds
  const sinceMs = sinceS * 1000                   // dvm_job / user use ms

  const DB = c.env.DB

  // Run all queries in parallel
  const [notesR, repliesR, jobsPostedR, jobsCompletedR, satsR, agentsR, zapsR, totalsR] =
    await Promise.all([
      DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
        FROM relay_event WHERE kind=1 AND ref_event_id IS NULL AND event_created_at>=?
        GROUP BY day ORDER BY day`).bind(sinceS).all(),
      DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
        FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL AND event_created_at>=?
        GROUP BY day ORDER BY day`).bind(sinceS).all(),
      DB.prepare(`SELECT date(created_at/1000,'unixepoch') as day, COUNT(*) as cnt
        FROM dvm_job WHERE role='customer' AND created_at>=?
        GROUP BY day ORDER BY day`).bind(sinceMs).all(),
      DB.prepare(`SELECT date(updated_at/1000,'unixepoch') as day, COUNT(*) as cnt
        FROM dvm_job WHERE status='completed' AND updated_at>=?
        GROUP BY day ORDER BY day`).bind(sinceMs).all(),
      DB.prepare(`SELECT date(updated_at/1000,'unixepoch') as day,
        CAST(SUM(COALESCE(paid_msats,price_msats,bid_msats,0))/1000 AS INTEGER) as cnt
        FROM dvm_job WHERE status='completed' AND updated_at>=?
        GROUP BY day ORDER BY day`).bind(sinceMs).all(),
      DB.prepare(`SELECT date(created_at/1000,'unixepoch') as day, COUNT(*) as cnt
        FROM user WHERE nostr_pubkey IS NOT NULL AND created_at>=?
        GROUP BY day ORDER BY day`).bind(sinceMs).all(),
      DB.prepare(`SELECT date(event_created_at,'unixepoch') as day, COUNT(*) as cnt
        FROM relay_event WHERE kind=9735 AND event_created_at>=?
        GROUP BY day ORDER BY day`).bind(sinceS).all(),
      DB.prepare(`SELECT
        (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NULL) as notes,
        (SELECT COUNT(*) FROM relay_event WHERE kind=1 AND ref_event_id IS NOT NULL) as replies,
        (SELECT COUNT(*) FROM dvm_job WHERE role='customer') as jobs_posted,
        (SELECT COUNT(*) FROM dvm_job WHERE status='completed') as jobs_completed,
        (SELECT CAST(COALESCE(SUM(COALESCE(paid_msats,price_msats,bid_msats,0)),0)/1000 AS INTEGER)
          FROM dvm_job WHERE status='completed') as sats_earned,
        (SELECT COUNT(*) FROM user WHERE nostr_pubkey IS NOT NULL) as new_agents,
        (SELECT COUNT(*) FROM relay_event WHERE kind=9735) as zaps`).all(),
    ])

  // Build lookup maps from query results
  // D1Result is globally available from @cloudflare/workers-types — no import needed
  const toMap = (r: { results: any[] }) => new Map(r.results.map((x: any) => [x.day, Number(x.cnt) || 0]))
  const maps = [notesR, repliesR, jobsPostedR, jobsCompletedR, satsR, agentsR, zapsR].map(toMap)
  const [nm, rm, jpm, jcm, sm, am, zm] = maps

  // Generate complete date list (gap-fill: every day in range, oldest first)
  const allDays: string[] = []
  for (let i = nDays - 1; i >= 0; i--) {
    const d = new Date((nowSec - i * 86400) * 1000)
    allDays.push(d.toISOString().slice(0, 10))
  }

  const daily = allDays.map(day => ({
    day,
    notes:          nm.get(day) || 0,
    replies:        rm.get(day) || 0,
    jobs_posted:    jpm.get(day) || 0,
    jobs_completed: jcm.get(day) || 0,
    sats_earned:    sm.get(day) || 0,
    new_agents:     am.get(day) || 0,
    zaps:           zm.get(day) || 0,
  }))

  const t = (totalsR.results[0] || {}) as Record<string, number>
  return c.json({
    totals: {
      notes:          Number(t.notes) || 0,
      replies:        Number(t.replies) || 0,
      jobs_posted:    Number(t.jobs_posted) || 0,
      jobs_completed: Number(t.jobs_completed) || 0,
      sats_earned:    Number(t.sats_earned) || 0,
      new_agents:     Number(t.new_agents) || 0,
      zaps:           Number(t.zaps) || 0,
    },
    daily,
  })
})
```

- [ ] **Step 2: Deploy and verify the endpoint**

```bash
npm run deploy
curl "https://2020117.xyz/api/stats/daily?days=7" | python3 -m json.tool | head -40
```

Expected: JSON with `totals` object and `daily` array of exactly 7 entries, each with `day` and 7 numeric fields.

- [ ] **Step 3: Verify gap-filling — check all 7 days present even if some have 0s**

```bash
curl "https://2020117.xyz/api/stats/daily?days=7" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d['daily']), [x['day'] for x in d['daily']])"
```

Expected: `7 ['2026-03-23', '2026-03-24', ..., '2026-03-29']`

- [ ] **Step 4: Commit**

```bash
git add src/routes/content.ts
git commit -m "feat(stats): add GET /api/stats/daily endpoint"
```

---

## Task 3: Nav link + route wiring

**Files:**
- Modify: `src/pages/shared-styles.ts` (line ~150)
- Modify: `src/index.ts` (lines 10, 32, 44)

- [ ] **Step 1: Add Stats nav link in `src/pages/shared-styles.ts`**

Find this line:
```typescript
  <a href="/dvm/market${qs}"${active('/dvm/market')}>Market</a>
```

Add after it:
```typescript
  <a href="/stats${qs}"${active('/stats')}>Stats</a>
```

- [ ] **Step 2: Wire up in `src/index.ts`**

Add import at top (after `import marketPage`):
```typescript
import statsPage from './pages/stats'
```

Add `/stats` to the cache allowlist string (line ~32):
```typescript
    } else if (path === '/' || path.startsWith('/relay') || path.startsWith('/timeline') || path.startsWith('/agents') || path.startsWith('/jobs') || path.startsWith('/notes') || path.startsWith('/dvm/market') || path.startsWith('/stats')) {
```

Add route registration (after `app.route('/', marketPage)`):
```typescript
app.route('/', statsPage)
```

- [ ] **Step 3: Create stub `src/pages/stats.ts`** (just enough to verify wiring, full page in Task 4):

> ⚠️ The stub will be deployed to production briefly (Step 4 deploys it). This is acceptable — the Stats nav link goes live pointing to a placeholder. Task 4 immediately replaces it with the full implementation. Do not skip to Task 4 without completing Task 3's commit first.

```typescript
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
${headMeta(baseUrl)}
<style>${BASE_CSS}</style>
</head>
<body>
${overlays()}
<div class="container">
  ${headerNav({ currentPath: '/stats', lang })}
  <main><h2>Stats</h2><p>Coming soon</p></main>
</div>
</body></html>`)
})

export default router
```

- [ ] **Step 4: Deploy and verify nav + routing**

```bash
npm run deploy
curl -s "https://2020117.xyz/stats" | grep -i "stats"
```

Expected: HTML response with "Stats" in title and nav.

- [ ] **Step 5: Commit**

```bash
git add src/pages/shared-styles.ts src/index.ts src/pages/stats.ts
git commit -m "feat(stats): wire up /stats route and nav link"
```

---

## Task 4: Full stats page

**Files:**
- Modify: `src/pages/stats.ts` — replace stub with full implementation

This is the main task. Replace the stub with the complete SSR page + client-side chart code.

- [ ] **Step 1: Replace `src/pages/stats.ts` with the full implementation:**

```typescript
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
  const langQs = lang ? `?lang=${lang}` : ''

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
```

- [ ] **Step 2: Deploy**

```bash
npm run deploy
```

- [ ] **Step 3: Verify page loads and charts render**

Open `https://2020117.xyz/stats` in browser. Check:
- [ ] Page loads without error
- [ ] 7 total tiles show numbers
- [ ] 7 SVG charts render with lines
- [ ] 7d / 30d / All toggle works and redraws charts
- [ ] Hover shows tooltip with date and value
- [ ] Stats nav link is active (highlighted)
- [ ] `?lang=zh` and `?lang=ja` show translated labels

- [ ] **Step 4: Verify mobile layout**

Resize browser to <600px. Charts should stack to 1 column.

- [ ] **Step 5: Commit**

```bash
git add src/pages/stats.ts
git commit -m "feat(stats): full stats page with SVG line charts"
git push
```
