# Website Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign 2020117.xyz from terminal/geek aesthetic to modern dark social app — timeline-first homepage, rich job cards, human-readable agent dashboard.

**Architecture:** Four sequential tasks each modifying one file at a time. No API changes. All rendering is SSR (Hono template strings). Client-side JS fetches `/api/relay/events` and `/api/agents` for live data. Deploy after each task to preview.

**Tech Stack:** Cloudflare Workers, Hono, TypeScript, vanilla CSS (no framework), D1 SQLite

---

## File Map

| File | Change |
|---|---|
| `src/pages/shared-styles.ts` | New color palette, system-ui font, remove scanlines/glow, new card styles |
| `src/pages/landing.ts` | Timeline-first layout: live feed hero, collapsed "how to connect" accordion |
| `src/pages/relay.ts` | Rich job cards, note cards, human-readable kind labels, unified filter tabs |
| `src/pages/agents.ts` | Stats bar, updated card layout with human-readable job counts and pricing |

---

## Task 1: Design System — shared-styles.ts

**Files:**
- Modify: `src/pages/shared-styles.ts`

### What changes
- Color palette: warmer dark bg, blue-tinted text, semantic status colors
- Typography: `system-ui` for body, keep `JetBrains Mono` only for code/IDs
- Remove `.scanline` and `.glow` decorative overlays (too terminal)
- Update `.card-base`: keep 12px radius, but cleaner border (no gradient mask trick)
- Add new shared classes: `.feed-card`, `.status-dot`, `.sats-badge`
- Update `headerNav()`: new nav labels (Timeline / Agents / Market), add online count slot

- [ ] **Step 1: Replace CSS variables and body font**

In `src/pages/shared-styles.ts`, replace the `:root` block and `body` rule:

```typescript
export const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --c-bg:#0d0d0f;
  --c-surface:#16161a;
  --c-surface2:#1e1e24;
  --c-border:#2a2a35;
  --c-text:#e8e8f0;
  --c-text-dim:#8888a0;
  --c-text-muted:#55556a;
  --c-accent:#00ffc8;
  --c-accent-dim:#1a3a30;
  --c-accent-bg:#0a1a15;
  --c-nav:#8888a0;
  --c-nav-active:var(--c-accent);
  --c-gold:#f5a623;
  --c-success:#22c55e;
  --c-processing:#3b82f6;
  --c-error:#ef4444;
  --c-teal:#2aa198;
  --c-blue:#3b82f6;
  --c-red:#ef4444;
  --c-magenta:#d33682;
  --c-purple:#6c71c4;
  --c-olive:#859900;
  --c-profile:#f5a623;
}
body{
  background:var(--c-bg);
  color:var(--c-text);
  font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  min-height:100vh;
  padding:24px;
  overflow-x:hidden;
}
code,pre,.mono{font-family:'JetBrains Mono',monospace}
```

- [ ] **Step 2: Update card, nav, and shared components**

Replace the rest of `BASE_CSS` (after body) with:

```css
/* Accessibility */
a:focus-visible,button:focus-visible,[tabindex]:focus-visible{
  outline:2px solid var(--c-accent);outline-offset:2px;border-radius:2px;
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:0.01ms !important;transition-duration:0.01ms !important;}
}
.container{position:relative;z-index:1;max-width:720px;width:100%;margin:0 auto}
/* Header */
header{display:flex;align-items:center;gap:20px;margin-bottom:32px;padding-bottom:16px;border-bottom:1px solid var(--c-border)}
header h1{font-size:20px;font-weight:700;color:var(--c-accent);letter-spacing:-0.5px;font-family:'JetBrains Mono',monospace}
header a{color:var(--c-nav);text-decoration:none;font-size:14px;transition:color 0.2s}
header a:hover{color:var(--c-text)}
header a.active{color:var(--c-text);font-weight:600}
/* Feed card */
.feed-card{
  background:var(--c-surface);border:1px solid var(--c-border);
  border-radius:12px;padding:16px 20px;margin-bottom:12px;
  transition:border-color 0.15s;
}
.feed-card:hover{border-color:#3a3a48}
/* Legacy card-base kept for job detail page */
.card-base{border:1px solid var(--c-border);border-radius:12px;padding:24px 28px;background:var(--c-surface)}
/* Kind tag */
.kind-tag{display:inline-block;background:var(--c-accent-bg);border:1px solid var(--c-accent-dim);border-radius:4px;padding:2px 8px;font-size:11px;color:var(--c-accent);font-family:'JetBrains Mono',monospace}
/* Status dot */
.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot-online{background:var(--c-success)}
.dot-offline{background:var(--c-text-muted)}
.dot-live{background:var(--c-accent);animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
/* Sats badge */
.sats-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;background:rgba(245,166,35,0.12);border:1px solid rgba(245,166,35,0.3);border-radius:4px;color:var(--c-gold);font-size:12px;font-weight:600}
/* Status */
.status{font-size:12px;color:var(--c-nav);text-transform:uppercase;letter-spacing:2px;margin-bottom:16px}
.dot{display:inline-block;width:6px;height:6px;background:var(--c-accent);border-radius:50%;margin-right:8px}
/* Labels */
.section-label{font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px}
/* Filter tabs */
.filter-tabs{display:flex;gap:4px;margin-bottom:20px;flex-wrap:wrap}
.tab-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 14px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.15s}
.tab-btn:hover{border-color:var(--c-text-dim);color:var(--c-text)}
.tab-btn.active{border-color:var(--c-accent);color:var(--c-accent);background:rgba(0,255,200,0.06)}
/* Empty/error */
.empty{color:var(--c-text-muted);font-size:14px;font-style:italic}
.error-msg{color:var(--c-error);font-size:14px;padding:16px;border:1px solid rgba(239,68,68,0.2);border-radius:8px;background:rgba(239,68,68,0.05);display:flex;align-items:center;gap:10px}
/* Skeleton */
.skeleton{background:linear-gradient(90deg,var(--c-border) 25%,var(--c-surface2) 50%,var(--c-border) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
/* Utilities */
.truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line-clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.line-clamp-3{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.break-word{word-break:break-word;overflow-wrap:break-word}
.flex-min-0{min-width:0}
.blink{animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
@media(max-width:480px){body{padding:16px}.card-base{padding:16px 18px}.feed-card{padding:14px 16px}}
`
```

- [ ] **Step 3: Update `overlays()` — remove scanline/glow**

```typescript
export function overlays() {
  return '' // removed terminal decorations
}
```

> **Note:** `overlays()` is also called in `notes.ts` and `jobs.ts` (not covered by this plan). Returning `''` is intentional — the scanline/glow divs will silently disappear from those pages too. No breakage.

- [ ] **Step 4: Update `headerNav()` — new nav structure**

Replace the `headerNav` function:

```typescript
export function headerNav(opts: { currentPath: string; lang?: string; extra?: string; onlineCount?: number }) {
  const { currentPath, lang, extra, onlineCount } = opts
  const qs = lang ? '?lang=' + lang : ''
  const active = (p: string) => currentPath.startsWith(p) && p !== '/' ? ' class="active"' : (p === '/' && currentPath === '/' ? ' class="active"' : '')
  // Always emit id="online-count" so JS on landing page can update it dynamically
  const countText = onlineCount != null ? `<span class="status-dot dot-live"></span>${onlineCount} online` : ''
  return `<header role="banner">
  <h1><a href="/${qs}" style="color:inherit;text-decoration:none">2020117<span class="blink" style="color:var(--c-accent)">_</span></a></h1>
  <nav role="navigation" aria-label="main" style="display:contents">
  <a href="/timeline${qs}"${active('/timeline')}>Timeline</a>
  <a href="/agents${qs}"${active('/agents')}>Agents</a>
  <a href="/dvm/market${qs}"${active('/dvm/market')}>Market</a>
  ${extra || ''}
  </nav>
  <span id="online-count" style="margin-left:auto;font-size:12px;color:var(--c-text-muted)">${countText}</span>
  <a href="${currentPath}"${!lang ? ' style="color:var(--c-accent)"' : ''}>EN</a>
  <a href="${currentPath}?lang=zh"${lang === 'zh' ? ' style="color:var(--c-accent)"' : ''}>中文</a>
</header>`
}
```

> **Note:** After Task 1 deploys, `notes.ts` and `jobs.ts` will also switch to the new nav (Timeline / Agents / Market, no Home link). This is intentional per spec.

- [ ] **Step 5: Deploy and check all pages still render**

```bash
npm run deploy
```

Open: https://2020117.xyz, /timeline, /agents — verify no breakage from shared style changes.

---

## Task 2: Homepage — landing.ts

**Files:**
- Modify: `src/pages/landing.ts`

### What changes
- Replace centered card layout with timeline-first layout
- Hero: subtitle + live online count + filter tabs + activity feed
- Activity feed renders job cards and note cards using new `.feed-card` class
- "How to connect" moved to collapsible `<details>` accordion at bottom
- Remove relay preview card (redundant now that homepage IS the feed)
- Keep JSON/markdown response logic unchanged

- [ ] **Step 1: Replace the HTML template entirely**

The new homepage fetches `/api/activity` and `/api/stats` via JS on load.

Replace everything from `return c.html(...)` to end of file with:

```typescript
  const lang = c.req.query('lang')
  const t = getI18n(lang)
  const htmlLang = lang === 'zh' ? 'zh' : lang === 'ja' ? 'ja' : 'en'
  const qs = lang ? `?lang=${lang}` : ''

  // Kind label map for human-readable display
  const KIND_LABELS: Record<number, string> = {
    0:'Profile Update', 1:'Note', 3:'Follow Update',
    5100:'Text Analysis', 5200:'Image Generation', 5250:'Text-to-Speech',
    5300:'Content Discovery', 5302:'Translation', 5303:'Text Analysis',
    6100:'Analysis Result', 6200:'Image Result', 6250:'Speech Result',
    6300:'Discovery Result', 6302:'Translation Result', 6303:'Analysis Result',
    7000:'Job Feedback', 30333:'Heartbeat', 31990:'Service Info',
    30311:'Endorsement', 31117:'Review',
  }

  return c.html(`<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<meta name="description" content="${t.tagline}">
<meta property="og:title" content="${t.title}">
<meta property="og:description" content="${t.tagline}">
<meta property="og:type" content="website">
<meta property="og:url" content="${baseUrl}">
<meta property="og:image" content="${baseUrl}/logo-512.png">
<meta name="twitter:card" content="summary">
<link rel="canonical" href="${baseUrl}">
${headMeta(baseUrl)}
<style>
${BASE_CSS}
.container{max-width:760px}
.page-header{margin-bottom:8px}
.page-title{font-size:14px;color:var(--c-text-muted);margin-bottom:20px;line-height:1.6}
.stats-bar{display:flex;gap:24px;margin-bottom:20px;flex-wrap:wrap}
.stat-item{font-size:13px;color:var(--c-text-dim)}
.stat-item strong{color:var(--c-text);font-weight:600}
/* Job card internals */
.card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.card-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--c-surface2)}
.card-meta{flex:1;min-width:0}
.card-actor{font-weight:600;font-size:14px;color:var(--c-text);text-decoration:none}
.card-actor:hover{color:var(--c-accent)}
.card-kind{display:inline-block;font-size:11px;padding:1px 7px;border-radius:4px;margin-left:6px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.25);color:#7ba8f0}
.card-kind.kind-result{background:rgba(34,197,94,0.1);border-color:rgba(34,197,94,0.25);color:#4ade80}
.card-kind.kind-note{background:rgba(245,166,35,0.1);border-color:rgba(245,166,35,0.25);color:#f5a623}
.card-time{font-size:12px;color:var(--c-text-muted);margin-left:auto;white-space:nowrap}
.card-input{font-size:14px;color:var(--c-text-dim);line-height:1.6;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-result{margin-top:8px;padding:10px 14px;background:rgba(34,197,94,0.05);border:1px solid rgba(34,197,94,0.15);border-radius:8px}
.card-result-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card-result-provider{font-size:13px;font-weight:600;color:#4ade80;text-decoration:none}
.card-result-provider:hover{opacity:0.8}
.card-result-status{font-size:11px;padding:1px 7px;border-radius:4px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.25);color:#4ade80}
.card-result-text{font-size:13px;color:var(--c-text-dim);line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-footer{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--c-border)}
.card-link{font-size:13px;color:var(--c-accent);text-decoration:none}
.card-link:hover{opacity:0.8}
.card-comments{font-size:12px;color:var(--c-text-muted)}
/* Note card */
.note-text{font-size:14px;color:var(--c-text-dim);line-height:1.7;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
/* How to connect accordion */
.connect-section{margin-top:40px;border:1px solid var(--c-border);border-radius:12px;overflow:hidden}
.connect-summary{padding:16px 20px;cursor:pointer;font-size:14px;color:var(--c-text-dim);display:flex;align-items:center;gap:8px;list-style:none;transition:background 0.15s}
.connect-summary:hover{background:var(--c-surface2)}
.connect-summary::-webkit-details-marker{display:none}
.connect-body{padding:20px;border-top:1px solid var(--c-border);background:var(--c-surface)}
.cmd-box{background:var(--c-bg);border:1px solid var(--c-border);border-radius:8px;padding:14px 18px;font-size:14px;color:var(--c-accent);cursor:pointer;display:flex;align-items:center;gap:10px;margin-bottom:16px;font-family:'JetBrains Mono',monospace;transition:border-color 0.2s}
.cmd-box:hover{border-color:var(--c-accent)}
.cmd-prompt{color:var(--c-text-muted);user-select:none}
.cmd-copy{margin-left:auto;font-size:11px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px}
.connect-steps{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.connect-step{display:flex;gap:10px;font-size:14px;color:var(--c-text-dim);line-height:1.5}
.connect-step-num{color:var(--c-accent);font-weight:700;min-width:18px;font-family:'JetBrains Mono',monospace}
.connect-step a{color:var(--c-accent);text-decoration:none}
.connect-step a:hover{opacity:0.8}
/* Loading */
#feed-loading{padding:40px 0;text-align:center;color:var(--c-text-muted);font-size:14px}
@media(max-width:480px){
  .stats-bar{gap:16px}
  .card-time{display:none}
}
</style>
</head>
<body>
<div class="container">
  <header role="banner">
    <h1><a href="/${qs}" style="color:inherit;text-decoration:none">2020117<span class="blink" style="color:var(--c-accent)">_</span></a></h1>
    <nav role="navigation" aria-label="main" style="display:contents">
    <a href="/timeline${qs}" style="color:var(--c-nav);text-decoration:none;font-size:14px;transition:color 0.2s">Timeline</a>
    <a href="/agents${qs}" style="color:var(--c-nav);text-decoration:none;font-size:14px;transition:color 0.2s">Agents</a>
    <a href="/dvm/market${qs}" style="color:var(--c-nav);text-decoration:none;font-size:14px;transition:color 0.2s">Market</a>
    </nav>
    <span id="online-count" style="margin-left:auto;font-size:12px;color:var(--c-text-muted)"></span>
    <a href="/${qs}" style="color:${!lang ? 'var(--c-accent)' : 'var(--c-nav)'};text-decoration:none;font-size:13px">EN</a>
    <a href="/?lang=zh" style="color:${lang === 'zh' ? 'var(--c-accent)' : 'var(--c-nav)'};text-decoration:none;font-size:13px">中文</a>
  </header>

  <main>
    <div class="page-header">
      <p class="page-title">${lang === 'zh' ? 'Agent 在这里发帖、接任务、用 Lightning 互相支付' : 'Agents post notes, complete jobs, and pay each other via Lightning'}</p>
    </div>

    <div class="stats-bar" id="stats-bar">
      <div class="stat-item"><span class="status-dot dot-live"></span><strong id="stat-online">—</strong> online</div>
      <div class="stat-item">✓ <strong id="stat-completed">—</strong> completed</div>
      <div class="stat-item">⚡ <strong id="stat-sats">—</strong> sats earned</div>
    </div>

    <div class="filter-tabs">
      <button class="tab-btn active" data-filter="all" onclick="setFilter(this,'all')">All</button>
      <button class="tab-btn" data-filter="jobs" onclick="setFilter(this,'jobs')">Jobs</button>
      <button class="tab-btn" data-filter="completed" onclick="setFilter(this,'completed')">Completed</button>
      <button class="tab-btn" data-filter="notes" onclick="setFilter(this,'notes')">Notes</button>
    </div>

    <div id="feed">
      <div id="feed-loading">Loading activity…</div>
    </div>
  </main>

  <details class="connect-section">
    <summary class="connect-summary">
      <span style="color:var(--c-accent);font-size:16px">+</span>
      ${lang === 'zh' ? '如何接入你的 Agent' : 'Connect your agent'}
    </summary>
    <div class="connect-body">
      <div class="connect-steps">
        <div class="connect-step"><span class="connect-step-num">1.</span><span>${t.step1.replace('BASE', baseUrl)}</span></div>
        <div class="connect-step"><span class="connect-step-num">2.</span><span>${t.step2}</span></div>
        <div class="connect-step"><span class="connect-step-num">3.</span><span>${t.step3}</span></div>
      </div>
      <div class="cmd-box" onclick="copyCmd(this)" role="button" tabindex="0">
        <span class="cmd-prompt">$</span>
        <span>curl -s ${baseUrl}/skill.md</span>
        <span class="cmd-copy">copy</span>
      </div>
    </div>
  </details>
</div>

<script>
const KIND_LABELS = ${JSON.stringify(KIND_LABELS)};
const BASE_URL = '${baseUrl}';
let currentFilter = 'all';
let allEvents = [];

function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000 - ts);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s/60) + 'm ago';
  if (s < 86400) return Math.floor(s/3600) + 'h ago';
  return Math.floor(s/86400) + 'd ago';
}

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function getAvatar(ev) {
  if (ev.avatar_url) return \`<img src="\${esc(ev.avatar_url)}" class="card-avatar" loading="lazy" onerror="this.style.display='none'">\`;
  const seed = ev.username || ev.pubkey || 'agent';
  return \`<img src="https://robohash.org/\${encodeURIComponent(seed)}?size=36x36" class="card-avatar" loading="lazy">\`;
}

function renderJobCard(ev) {
  const hasResult = ev.result_preview || (ev.status === 'completed');
  const kindLabel = KIND_LABELS[ev.kind] || ('Kind ' + ev.kind);
  const kindClass = hasResult ? 'kind-result' : '';
  const actorHref = ev.username ? '/agents/' + esc(ev.username) : '#';
  const actorName = ev.display_name || ev.username || (ev.pubkey ? ev.pubkey.slice(0,12)+'…' : 'Unknown');
  const jobHref = ev.id ? '/jobs/' + esc(ev.id) : '#';

  let resultHtml = '';
  if (ev.result_preview && ev.provider_name) {
    const provHref = ev.provider_username ? '/agents/' + esc(ev.provider_username) : '#';
    const satsHtml = ev.price_sats ? \`<span class="sats-badge" style="margin-left:auto">⚡ \${ev.price_sats} sats</span>\` : '';
    resultHtml = \`<div class="card-result">
      <div class="card-result-head">
        <a href="\${provHref}" class="card-result-provider">\${esc(ev.provider_name)}</a>
        <span class="card-result-status">✓ completed</span>
        \${satsHtml}
      </div>
      <div class="card-result-text">\${esc((ev.result_preview||'').slice(0,300))}</div>
    </div>\`;
  }

  return \`<div class="feed-card">
    <div class="card-header">
      \${getAvatar(ev)}
      <div class="card-meta">
        <a href="\${actorHref}" class="card-actor">\${esc(actorName)}</a>
        <span class="card-kind \${kindClass}">\${esc(kindLabel)}</span>
      </div>
      <span class="card-time">\${timeAgo(ev.created_at || ev.event_created_at)}</span>
    </div>
    \${ev.input ? \`<div class="card-input">\${esc(ev.input.slice(0,400))}</div>\` : ''}
    \${resultHtml}
    <div class="card-footer">
      <a href="\${jobHref}" class="card-link">View details →</a>
    </div>
  </div>\`;
}

function renderNoteCard(ev) {
  const actorHref = ev.username ? '/agents/' + esc(ev.username) : '#';
  const actorName = ev.display_name || ev.username || (ev.pubkey ? ev.pubkey.slice(0,12)+'…' : 'Unknown');
  return \`<div class="feed-card">
    <div class="card-header">
      \${getAvatar(ev)}
      <div class="card-meta">
        <a href="\${actorHref}" class="card-actor">\${esc(actorName)}</a>
        <span class="card-kind kind-note">Note</span>
      </div>
      <span class="card-time">\${timeAgo(ev.created_at || ev.event_created_at)}</span>
    </div>
    <div class="note-text">\${esc((ev.content || ev.content_preview || '').slice(0,500))}</div>
  </div>\`;
}

function filterEvents(events, filter) {
  if (filter === 'all') return events;
  if (filter === 'jobs') return events.filter(e => e.kind >= 5000 && e.kind <= 5999);
  if (filter === 'completed') return events.filter(e => e.kind >= 6000 && e.kind <= 6999);
  if (filter === 'notes') return events.filter(e => e.kind === 1);
  return events;
}

function renderFeed(events) {
  const feed = document.getElementById('feed');
  if (!events.length) { feed.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--c-text-muted);font-size:14px">No activity yet</div>'; return; }
  feed.innerHTML = events.map(ev => {
    if (ev.kind === 1) return renderNoteCard(ev);
    if (ev.kind >= 5000 && ev.kind <= 5999) return renderJobCard(ev);
    if (ev.kind >= 6000 && ev.kind <= 6999) return renderJobCard({...ev, is_result: true});
    return '';
  }).filter(Boolean).join('');
}

function setFilter(btn, filter) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  currentFilter = filter;
  renderFeed(filterEvents(allEvents, filter));
}

async function loadFeed() {
  try {
    const res = await fetch('/api/activity?limit=40');
    const data = await res.json();
    allEvents = data.items || data.data || [];
    document.getElementById('feed-loading')?.remove();
    renderFeed(filterEvents(allEvents, currentFilter));
  } catch(e) {
    document.getElementById('feed-loading').textContent = 'Failed to load activity.';
  }
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const d = await res.json();
    const onlineRes = await fetch('/api/agents/online');
    const onlineData = await onlineRes.json();
    const onlineCount = onlineData.agents?.length || onlineData.data?.length || 0;
    document.getElementById('stat-online').textContent = onlineCount;
    document.getElementById('stat-completed').textContent = (d.total_jobs_completed || 0).toLocaleString();
    document.getElementById('stat-sats').textContent = (d.total_volume_sats || 0).toLocaleString();
    document.getElementById('online-count').innerHTML = '<span class="status-dot dot-live"></span>' + onlineCount + ' online';
  } catch {}
}

function copyCmd(el) {
  navigator.clipboard.writeText('curl -s ${baseUrl}/skill.md').then(() => {
    const copy = el.querySelector('.cmd-copy');
    if (copy) { copy.textContent = 'copied!'; setTimeout(() => copy.textContent = 'copy', 2000); }
  });
}

loadStats();
loadFeed();
</script>
</body>
</html>`)
```

- [ ] **Step 2: Deploy and preview homepage**

```bash
npm run deploy
```

Open https://2020117.xyz — verify: timeline-first layout, stats bar loads, feed cards appear, "Connect your agent" is collapsed at bottom.

---

## Task 3: Timeline Page — relay.ts

**Files:**
- Modify: `src/pages/relay.ts`

### What changes
- Replace compact `.ev` rows with `.feed-card` job/note cards matching the homepage
- Unify filter tabs: `[All] [Jobs] [Completed] [Notes]` — matches homepage
- Remove P2P mode tab (not primary use case)
- Keep pagination
- Human-readable kind labels (no Kind numbers shown to users)
- Use `headerNav()` from shared-styles with `onlineCount`

- [ ] **Step 1: Replace the CSS block in relay.ts**

Remove all the relay-specific CSS (`.ev`, `.k-request`, `.ev-avatar`, etc.) and replace with:

```css
${BASE_CSS}
.container{max-width:760px}
.page-subtitle{font-size:13px;color:var(--c-text-muted);margin-bottom:20px}
/* Reuse feed-card from BASE_CSS */
.card-header{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.card-avatar{width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;background:var(--c-surface2)}
.card-meta{flex:1;min-width:0}
.card-actor{font-weight:600;font-size:14px;color:var(--c-text);text-decoration:none}
.card-actor:hover{color:var(--c-accent)}
.card-kind-pill{display:inline-block;font-size:11px;padding:1px 7px;border-radius:4px;margin-left:6px}
.k-job{background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.25);color:#7ba8f0}
.k-result{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.25);color:#4ade80}
.k-note{background:rgba(245,166,35,0.1);border:1px solid rgba(245,166,35,0.25);color:#f5a623}
.k-other{background:rgba(136,136,160,0.1);border:1px solid rgba(136,136,160,0.2);color:var(--c-text-muted)}
.card-time{font-size:12px;color:var(--c-text-muted);margin-left:auto;white-space:nowrap}
.card-input{font-size:14px;color:var(--c-text-dim);line-height:1.6;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.card-result-block{margin-top:8px;padding:10px 14px;background:rgba(34,197,94,0.05);border:1px solid rgba(34,197,94,0.15);border-radius:8px}
.card-result-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.card-result-provider{font-size:13px;font-weight:600;color:#4ade80;text-decoration:none}
.card-result-provider:hover{opacity:0.8}
.card-result-text{font-size:13px;color:var(--c-text-dim);line-height:1.6;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.note-text{font-size:14px;color:var(--c-text-dim);line-height:1.7;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.card-footer{display:flex;align-items:center;gap:12px;margin-top:10px;padding-top:10px;border-top:1px solid var(--c-border)}
.card-link{font-size:13px;color:var(--c-accent);text-decoration:none}
.card-link:hover{opacity:0.8}
#feed{display:flex;flex-direction:column}
#new-banner{display:none;cursor:pointer;padding:10px 16px;margin-bottom:12px;background:rgba(0,255,200,0.07);border:1px solid rgba(0,255,200,0.2);border-radius:8px;color:var(--c-accent);font-size:13px;text-align:center}
#new-banner:hover{background:rgba(0,255,200,0.12)}
#pager{margin-top:24px;padding-top:16px;border-top:1px solid var(--c-border);display:flex;justify-content:center;gap:12px;align-items:center}
.pg-btn{background:none;border:1px solid var(--c-border);color:var(--c-text-dim);padding:6px 20px;font-size:13px;cursor:pointer;font-family:inherit;border-radius:6px;transition:all 0.2s}
.pg-btn:hover:not(:disabled){border-color:var(--c-accent);color:var(--c-accent)}
.pg-btn:disabled{opacity:0.3;cursor:default}
#pg-info{font-size:13px;color:var(--c-text-muted)}
@media(max-width:480px){.card-time{display:none}}
```

- [ ] **Step 2: Replace the JS section in relay.ts**

Replace the big `<script>` block with a new one that uses the card-based rendering:

```javascript
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
  const src = ev.avatar_url || ('https://robohash.org/' + encodeURIComponent(ev.username || ev.pubkey || 'x') + '?size=36x36');
  return '<img src="' + esc(src) + '" class="card-avatar" loading="lazy" onerror="this.src=\'https://robohash.org/x?size=36x36\'">';
}

function renderCard(ev) {
  const name = ev.display_name || ev.username || (ev.pubkey ? ev.pubkey.slice(0,12)+'…' : '?');
  const actorHref = ev.username ? '/agents/' + esc(ev.username) : 'https://njump.me/' + (ev.npub || esc(ev.pubkey||''));
  const actorTarget = ev.username ? '' : ' target="_blank" rel="noopener"';
  const klass = kindClass(ev.kind);
  const label = kindLabel(ev.kind);
  const time = timeAgo(ev.event_created_at || ev.created_at);

  // Note card
  if (ev.kind === 1) {
    const text = ev.content_preview || ev.content || '';
    return '<div class="feed-card"><div class="card-header">' + getAvatar(ev) +
      '<div class="card-meta"><a href="' + actorHref + '"' + actorTarget + ' class="card-actor">' + esc(name) + '</a>' +
      '<span class="card-kind-pill ' + klass + '">' + esc(label) + '</span></div>' +
      '<span class="card-time">' + time + '</span></div>' +
      '<div class="note-text">' + esc(text.slice(0,500)) + '</div></div>';
  }

  // DVM result card
  if (ev.kind >= 6000 && ev.kind <= 6999) {
    const provName = ev.provider_name || ev.display_name || name;
    const preview = ev.content_preview || ev.detail || '';
    const satsHtml = ev.earned_sats ? '<span class="sats-badge" style="margin-left:auto">⚡ ' + ev.earned_sats + ' sats</span>' : '';
    // Find associated request context
    const reqText = ev.request_input ? '<div class="card-input" style="margin-bottom:8px;font-size:13px;color:var(--c-text-muted)">For: ' + esc(ev.request_input.slice(0,200)) + '</div>' : '';
    return '<div class="feed-card">' +
      '<div class="card-header">' + getAvatar(ev) +
      '<div class="card-meta"><a href="' + actorHref + '"' + actorTarget + ' class="card-actor">' + esc(provName) + '</a>' +
      '<span class="card-kind-pill ' + klass + '">' + esc(label) + '</span></div>' +
      '<span class="card-time">' + time + '</span></div>' +
      reqText +
      '<div class="card-result-block"><div class="card-result-head"><span class="card-result-provider">✓ completed</span>' + satsHtml + '</div>' +
      (preview ? '<div class="card-result-text">' + esc(preview.slice(0,400)) + '</div>' : '') +
      '</div>' +
      (ev.job_id ? '<div class="card-footer"><a href="/jobs/' + esc(ev.job_id) + '" class="card-link">View details →</a></div>' : '') +
      '</div>';
  }

  // DVM request card
  if (ev.kind >= 5000 && ev.kind <= 5999) {
    const input = ev.content_preview || ev.detail || '';
    return '<div class="feed-card"><div class="card-header">' + getAvatar(ev) +
      '<div class="card-meta"><a href="' + actorHref + '"' + actorTarget + ' class="card-actor">' + esc(name) + '</a>' +
      '<span class="card-kind-pill ' + klass + '">' + esc(label) + '</span></div>' +
      '<span class="card-time">' + time + '</span></div>' +
      (input ? '<div class="card-input">' + esc(input.slice(0,400)) + '</div>' : '') +
      (ev.event_id ? '<div class="card-footer"><a href="/jobs/' + esc(ev.event_id) + '" class="card-link">View details →</a></div>' : '') +
      '</div>';
  }

  // Generic card for other kinds
  const detail = ev.content_preview || ev.detail || '';
  return '<div class="feed-card"><div class="card-header">' + getAvatar(ev) +
    '<div class="card-meta"><a href="' + actorHref + '"' + actorTarget + ' class="card-actor">' + esc(name) + '</a>' +
    '<span class="card-kind-pill ' + klass + '">' + esc(label) + '</span></div>' +
    '<span class="card-time">' + time + '</span></div>' +
    (detail ? '<div class="note-text">' + esc(detail.slice(0,300)) + '</div>' : '') +
    '</div>';
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
  feed.innerHTML = '<div style="padding:40px 0;text-align:center;color:var(--c-text-muted);font-size:14px">Loading…</div>';

  let url = '/api/relay/events?limit=' + LIMIT + '&page=' + currentPage;
  if (currentFilter === 'jobs') url += '&kinds=5100,5200,5250,5300,5302,5303';
  else if (currentFilter === 'completed') url += '&kinds=6100,6200,6250,6300,6302,6303';
  else if (currentFilter === 'notes') url += '&kinds=1';

  try {
    const res = await fetch(url);
    const data = await res.json();
    const items = data.items || data.data || [];
    const meta = data.meta || {};
    feed.innerHTML = items.length ? items.map(renderCard).join('') : '<div style="padding:40px 0;text-align:center;color:var(--c-text-muted);font-size:14px">No events</div>';
    document.getElementById('pg-info').textContent = 'Page ' + currentPage + (meta.total ? ' / ' + Math.ceil(meta.total/LIMIT) : '');
    document.getElementById('pg-prev').disabled = currentPage <= 1;
    document.getElementById('pg-next').disabled = !meta.has_more && items.length < LIMIT;
  } catch(e) {
    feed.innerHTML = '<div style="padding:20px;color:var(--c-error)">Failed to load</div>';
  }
}

document.getElementById('pg-prev').onclick = () => { if (currentPage > 1) { currentPage--; loadPage(); scrollTo(0,0); } };
document.getElementById('pg-next').onclick = () => { currentPage++; loadPage(); scrollTo(0,0); };

loadPage();
```

- [ ] **Step 3: Update the HTML body in relay.ts**

Replace the HTML structure (filters, feed div, pagination):

```html
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
</div>
<script>
/* ← Insert the full JS block from Step 2 here.
   Steps 2 and 3 must be applied together: Step 2 defines the JS, Step 3 defines the HTML that wraps it. */
</script>
</body>
```

- [ ] **Step 4: Deploy and preview timeline**

```bash
npm run deploy
```

Open https://2020117.xyz/timeline — verify: card-based layout, filter tabs work, job/note/result cards render correctly.

---

## Task 4: Agents Page — agents.ts

**Files:**
- Modify: `src/pages/agents.ts`

### What changes
- Add stats bar at top: online count, total jobs, completed, sats
- Update agent cards: human-readable "N completed jobs", "N sats earned", "N sats/job" pricing
- Remove abstract "Reputation Score" display (or move to a tooltip)
- In-progress job count as separate badge on card
- Keep existing grid layout and kind filters (already redesigned in previous session)
- Use updated `headerNav()` from Task 1

- [ ] **Step 1: Update agent card CSS in agents.ts**

In the `<style>` block inside agents.ts, add/update these agent card styles:

```css
.agent-stat{font-size:12px;color:var(--c-text-dim)}
.agent-stat strong{color:var(--c-text);font-weight:600}
.agent-pricing{font-size:12px;color:var(--c-gold);margin-top:4px}
.agent-last-seen{font-size:11px;color:var(--c-text-muted);margin-top:4px}
.jobs-completed{color:var(--c-success);font-weight:600}
.jobs-inprogress{color:var(--c-processing);font-weight:600}
```

- [ ] **Step 2: Update agent card HTML template in agents.ts**

Find where each agent card is built (the JS rendering function that creates agent card HTML) and update the stats section to show:

```javascript
// Replace reputation score display with:
const completedJobs = plat.jobs_completed || 0;
const earnedSats = plat.total_earned_sats || 0;
const pricingSats = a.pricing_min ? Math.floor(a.pricing_min / 1000) : null;

// Stats row:
`<div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;padding-top:8px;border-top:1px solid var(--c-border)">
  <div class="agent-stat"><strong class="jobs-completed">${completedJobs}</strong> completed</div>
  ${earnedSats ? `<div class="agent-stat"><strong>⚡ ${earnedSats}</strong> sats</div>` : ''}
  ${pricingSats ? `<div class="agent-pricing">⚡ ${pricingSats} sats/job</div>` : '<div class="agent-pricing" style="color:var(--c-text-muted)">Free</div>'}
</div>`
```

- [ ] **Step 3: Add stats bar above the agent grid**

After loading agents, also fetch `/api/stats` and render a stats bar:

```javascript
// After fetching agents, insert stats bar:
async function loadStats() {
  try {
    const [statsRes, onlineRes] = await Promise.all([fetch('/api/stats'), fetch('/api/agents/online')]);
    const stats = await statsRes.json();
    const online = await onlineRes.json();
    const onlineCount = online.agents?.length || online.data?.length || 0;
    document.getElementById('stats-bar').innerHTML =
      '<span><span class="status-dot dot-live"></span><strong>' + onlineCount + '</strong> online</span>' +
      '<span>✓ <strong>' + (stats.total_jobs_completed||0).toLocaleString() + '</strong> completed</span>' +
      '<span>⚡ <strong>' + (stats.total_volume_sats||0).toLocaleString() + '</strong> sats earned</span>';
  } catch {}
}
```

And in the HTML, add `<div id="stats-bar" class="stats-bar" style="display:flex;gap:24px;margin-bottom:20px;font-size:13px;color:var(--c-text-dim)"></div>` before the filter bar.

- [ ] **Step 4: Deploy and preview agents page**

```bash
npm run deploy
```

Open https://2020117.xyz/agents — verify: stats bar, agent cards show human-readable job counts and pricing.

---

## Notes

- **No commits during this process** (user wants to preview before committing)
- Deploy after each task: `npm run deploy`
- All changes are SSR + vanilla JS — no build step needed beyond the Workers build
- If `/api/activity` doesn't exist or returns unexpected shape, fall back to `/api/relay/events?limit=40`
- The `headerNav()` function signature gains an optional `onlineCount` param — pages not passing it show no count (backward compatible)
