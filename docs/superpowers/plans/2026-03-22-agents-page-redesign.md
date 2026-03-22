# Agents Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve the `/agents` listing page with kind filtering, 3-column grid, and the `/agents/:username` detail page with recent activity sections and a copy-able CLI command.

**Architecture:** All changes are in a single file `src/pages/agents.ts`. The listing page is client-side rendered (JS fetches `/api/agents` and builds HTML). The detail page is SSR. No API, schema, or other file changes required.

**Tech Stack:** Hono SSR, inline JS/CSS, Drizzle ORM + D1 (SQLite), Cloudflare Workers

---

## File Map

| File | Change |
|------|--------|
| `src/pages/agents.ts` | All changes — listing CSS/JS and detail SSR handler |

No new files. No other files touched.

---

### Task 1: Bio color fix (listing + detail)

**Files:**
- Modify: `src/pages/agents.ts` (listing CSS ~line 80, detail CSS ~line 461)

- [ ] **Step 1: Fix listing page bio color**

In `src/pages/agents.ts`, find the `.agent-bio` rule inside the listing page `<style>` block (~line 80):

```css
/* Before */
.agent-bio{
  color:var(--c-text-dim);font-size:14px;
  margin-bottom:8px;
}

/* After */
.agent-bio{
  color:var(--c-text);font-size:14px;
  margin-bottom:8px;
}
```

- [ ] **Step 2: Fix detail page bio color**

In the same file, find the `.agent-bio` rule inside the detail page `<style>` block (~line 461):

```css
/* Before */
.agent-bio{
  color:var(--c-text-muted);font-size:15px;
  margin-bottom:16px;
  line-height:1.5;
}

/* After */
.agent-bio{
  color:var(--c-text);font-size:15px;
  margin-bottom:16px;
  line-height:1.5;
}
```

- [ ] **Step 3: Verify locally**

```bash
npm run dev
```

Open `http://localhost:8787/agents` — bio text should now be near-white instead of grey-green.
Open `http://localhost:8787/agents/claude_bot` — detail bio text should also be near-white.

- [ ] **Step 4: Commit**

```bash
git add src/pages/agents.ts
git commit -m "fix: make agent bio text visible (use --c-text instead of dim/muted)"
```

---

### Task 2: 3-column grid layout + condensed cards

**Files:**
- Modify: `src/pages/agents.ts` (listing CSS ~lines 33–111, listing JS ~lines 143–201)

**Overview:** Replace the single-column flex layout with a 3-column CSS grid. Simplify each card to show only: avatar+name, bio (2 lines), kind tags, and 3 key stats.

- [ ] **Step 1: Update `#agents` CSS to grid**

Replace the `#agents` and `.agent-card` CSS block and add responsive grid + compact stats styles. Find the existing `<style>` block in the listing page (`router.get('/agents', ...)`) and replace the relevant rules:

```css
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
.agent-stats-compact{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-top:10px;padding-top:8px;
  border-top:1px solid var(--c-border);
}
.stat-chip{
  display:flex;flex-direction:column;
  font-size:11px;
}
.stat-chip-label{
  color:var(--c-text-muted);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;
}
.stat-chip-value{
  color:var(--c-text);font-weight:700;font-size:13px;
}
```

Remove the old `.agent-stats`, `.agent-npub`, `.pagination` button rules (pagination stays, just remove the unused stat grid rules).

- [ ] **Step 2: Rewrite the card HTML in the JS `load()` function**

Find the card-building loop (starts at `for(const a of agents){`) and replace the entire card HTML generation with a condensed version. The new card omits: full stats grid (14 cells), npub row, the npub anchor with `stopPropagation`.

Replace lines 143–201 with:

```javascript
for(const a of agents){
  const avatarSrc=a.avatar_url||(a.username?'https://robohash.org/'+encodeURIComponent(a.username):'https://robohash.org/'+encodeURIComponent(a.nostr_pubkey||'unknown'));
  const avatar='<img class="agent-avatar" src="'+esc(avatarSrc)+'" alt="'+esc(a.display_name||a.username||'agent')+' avatar" loading="lazy">';
  const bioText=a.bio?a.bio.replace(/<[^>]*>/g,'').slice(0,200):'';
  const bio=bioText?'<div class="agent-bio" style="overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">'+esc(bioText)+'</div>':'';
  let kinds='';
  for(const s of (a.services||[])){
    for(const label of (s.kind_labels||[])){
      kinds+='<span class="kind-tag">\u26A1 '+esc(label)+'</span>';
    }
  }
  const rep=a.reputation||{};
  const plat=rep.platform||{};
  const completed=plat.jobs_completed||a.completed_jobs_count||0;
  const earned=(plat.total_earned_sats||a.earned_sats||0);
  const repScore=rep.score||0;
  const liveBadge=a.live?'<span class="live-badge">LIVE</span>':'';
  const url=a.username?'/agents/'+encodeURIComponent(a.username)+'${lang ? '?lang=' + lang : ''}':'#';
  const stats='<div class="agent-stats-compact">'
    +'<div class="stat-chip"><span class="stat-chip-label">done</span><span class="stat-chip-value">'+completed+'</span></div>'
    +'<div class="stat-chip"><span class="stat-chip-label">earned</span><span class="stat-chip-value" style="color:var(--c-gold)">\u26A1'+earned+'</span></div>'
    +'<div class="stat-chip"><span class="stat-chip-label">rep</span><span class="stat-chip-value" style="color:var(--c-accent)">'+repScore+'</span></div>'
    +'</div>';
  html+='<div class="agent-card"'+(a.username?' onclick="location.href=\''+esc(url)+'\'" role="link" tabindex="0" onkeydown="if(event.key===\'Enter\')location.href=\''+esc(url)+'\'"':'')+' >'
    +'<div class="agent-header">'+avatar
    +'<span class="agent-name">'+esc(a.display_name||a.username||'unknown')+liveBadge+'</span></div>'
    +bio
    +'<div class="agent-services">'+kinds+'</div>'
    +stats
    +'</div>';
}
```

- [ ] **Step 3: Verify locally**

```bash
npm run dev
```

Open `http://localhost:8787/agents` — should see 3 columns on desktop, condensed cards with just avatar/name/bio/tags/3-stats.

- [ ] **Step 4: Commit**

```bash
git add src/pages/agents.ts
git commit -m "feat: 3-column grid layout with condensed agent cards"
```

---

### Task 3: Kind filter pills (listing page)

**Files:**
- Modify: `src/pages/agents.ts` (listing CSS + HTML template + JS)

- [ ] **Step 1: Add pill CSS to listing page styles**

Add to the listing page `<style>` block:

```css
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
  background:rgba(0,255,200,0.05);
}
```

- [ ] **Step 2: Add pill bar HTML to the page template**

In the listing page HTML (inside `<main>`), add the pill bar before `<div id="agents">`:

```html
<div class="kind-pills" id="kindPills">
  <button class="kind-pill active" data-kind="0">全部</button>
  <button class="kind-pill" data-kind="5100">text processing · 5100</button>
  <button class="kind-pill" data-kind="5200">text-to-image · 5200</button>
  <button class="kind-pill" data-kind="5250">video generation · 5250</button>
  <button class="kind-pill" data-kind="5300">text-to-speech · 5300</button>
  <button class="kind-pill" data-kind="5301">speech-to-text · 5301</button>
  <button class="kind-pill" data-kind="5302">translation · 5302</button>
  <button class="kind-pill" data-kind="5303">summarization · 5303</button>
</div>
```

- [ ] **Step 3: Add filter state + pill JS logic**

At the top of the `<script>` block, add:

```javascript
let allAgentsCache=[];
let selectedKind=0;

document.getElementById('kindPills').addEventListener('click',function(e){
  const pill=e.target.closest('.kind-pill');
  if(!pill)return;
  document.querySelectorAll('.kind-pill').forEach(p=>p.classList.remove('active'));
  pill.classList.add('active');
  selectedKind=parseInt(pill.dataset.kind)||0;
  renderAgents(allAgentsCache);
});

function filterAgents(agents){
  if(selectedKind===0)return agents;
  return agents.filter(a=>(a.services||[]).some(s=>(s.kinds||[]).includes(selectedKind)));
}
```

- [ ] **Step 4: Update `load()` to cache agents and call `renderAgents()`**

Refactor the `load()` function to store agents in `allAgentsCache` and delegate rendering to a new `renderAgents()` function. Also remove the now-unused `navigate()` and `popstate` functions since pagination is replaced by client-side filtering.

```javascript
async function load(){
  try{
    const r=await fetch('${baseUrl}/api/agents?limit=50&page=1');
    const el=document.getElementById('agents');
    if(!r.ok){el.innerHTML='<div class="error-msg"><span>Failed to load agents</span><button onclick="load()">retry</button></div>';return}
    const data=await r.json();
    allAgentsCache=data.agents||data;
    renderAgents(allAgentsCache);
  }catch(e){
    console.error(e);
    document.getElementById('agents').innerHTML='<div class="error-msg"><span>Network error</span><button onclick="load()">retry</button></div>';
  }
}

function renderAgents(agents){
  const filtered=filterAgents(agents);
  const el=document.getElementById('agents');
  if(!filtered.length){el.innerHTML='<div class="empty">${t.noAgents}</div>';return}
  let html='';
  // ... (card building loop from Task 2, unchanged)
  el.innerHTML=html;
}
```

Note: fetch `limit=50` (the API hard-max). Remove the old `navigate()`, `getPageFromUrl()`, and `window.addEventListener('popstate', ...)` — pagination is replaced by client-side kind filtering. Call `load()` (no argument) at the bottom of the script.

- [ ] **Step 5: Verify locally**

```bash
npm run dev
```

Open `http://localhost:8787/agents`. Click kind pills — grid should filter to matching agents. "全部" shows all.

- [ ] **Step 6: Commit**

```bash
git add src/pages/agents.ts
git commit -m "feat: add kind filter pills to agents listing page"
```

---

### Task 4: Detail page — recent jobs, reviews, earnings (DB + render)

**Files:**
- Modify: `src/pages/agents.ts` (detail SSR handler ~lines 233–554)

- [ ] **Step 1: Fix `DVM_KIND_LABELS` to use lowercase labels (sync with `helpers.ts`)**

The detail handler has its own copy at ~line 278 with Title Case. Update it first so all subsequent HTML generation uses correct labels:

```typescript
// Before
const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'Text Generation', 5200: 'Text-to-Image', 5250: 'Video Generation',
  5300: 'Text-to-Speech', 5301: 'Speech-to-Text', 5302: 'Translation', 5303: 'Summarization',
}

// After (matches src/routes/helpers.ts exactly)
const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'text processing', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
}
```

- [ ] **Step 2: Add `dvmReviews` to the dynamic schema import and `descOp` to drizzle import**

In the detail handler, find the dynamic import (~line 233):

```typescript
// Before
const { users, dvmServices, dvmJobs, agentHeartbeats, dvmEndorsements, relayEvents, dvmTrust } = await import('../db/schema')
const { eq, and: andOp, sql: sqlOp } = await import('drizzle-orm')

// After
const { users, dvmServices, dvmJobs, agentHeartbeats, dvmEndorsements, relayEvents, dvmTrust, dvmReviews } = await import('../db/schema')
const { eq, and: andOp, sql: sqlOp, desc: descOp } = await import('drizzle-orm')
```

- [ ] **Step 3: Add `.section-label` CSS to the detail page `<style>` block**

The detail page uses `class="section-label"` but this rule does not exist in its `<style>` block. Add it alongside the existing `.section` rule (~line 465):

```css
.section-label{
  font-size:10px;color:var(--c-text-muted);text-transform:uppercase;letter-spacing:1px;
  margin-bottom:6px;
}
```

- [ ] **Step 4: Add 3 new queries to the existing `Promise.all`**

The existing `Promise.all` is at ~line 342. Extend it to include 3 more queries. All are conditional on `u.nostrPubkey`:

```typescript
const [jobStats, spendStats, nostrStats, wotStats, recentJobs, recentReviews, recentEarnings] = await Promise.all([
  // ... existing 4 queries unchanged ...

  // 5. Recent jobs as provider (last 10)
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

  // 6. Recent reviews received (last 10)
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

  // 7. Recent earnings (last 10 paid completions)
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
```

- [ ] **Step 5: Build HTML helpers for the 3 sections**

Add these helper functions just before the `return c.html(...)` call. Use the same `DVM_KIND_LABELS` map already defined at line 278 in the detail handler:

```typescript
function fmtTime(dt: Date | null | number): string {
  if (!dt) return '-'
  const d = typeof dt === 'number' ? new Date(dt * 1000) : new Date(dt as any)
  return isNaN(d.getTime()) ? '-' : d.toLocaleDateString()
}

function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    completed: 'var(--c-accent)', pending: 'var(--c-text-muted)',
    processing: 'var(--c-blue)', failed: '#e06c75', rejected: '#e06c75',
  }
  const col = colors[status] || 'var(--c-text-muted)'
  return `<span style="font-size:11px;color:${col};border:1px solid ${col};border-radius:3px;padding:1px 6px">${esc(status)}</span>`
}

const recentJobsHtml = recentJobs.length > 0 ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Recent Jobs</div>
  <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
    ${recentJobs.map(j => {
      const kindLabel = DVM_KIND_LABELS[j.kind] || `kind ${j.kind}`
      const sats = Math.floor((j.earnedMsats || 0) / 1000)
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--c-border)">
        <span style="color:var(--c-text-muted);min-width:80px">${fmtTime(j.updatedAt)}</span>
        <span style="color:var(--c-text)">${esc(kindLabel)}</span>
        ${statusBadge(j.status || '')}
        ${sats > 0 ? `<span style="color:var(--c-gold);margin-left:auto">⚡${sats}</span>` : ''}
      </div>`
    }).join('')}
  </div>
</div>` : ''

const recentReviewsHtml = recentReviews.length > 0 ? `
<div class="section" style="margin-top:24px">
  <div class="section-label">Recent Reviews</div>
  <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
    ${recentReviews.map(r => {
      const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)
      const kindLabel = DVM_KIND_LABELS[r.jobKind] || `kind ${r.jobKind}`
      const text = r.content ? esc(r.content.slice(0, 120)) + (r.content.length > 120 ? '…' : '') : ''
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
  <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
    ${recentEarnings.map(e => {
      const kindLabel = DVM_KIND_LABELS[e.kind] || `kind ${e.kind}`
      const sats = Math.floor((e.earnedMsats || 0) / 1000)
      return `<div style="display:flex;align-items:center;gap:8px;font-size:13px;padding:6px 0;border-bottom:1px solid var(--c-border)">
        <span style="color:var(--c-text-muted);min-width:80px">${fmtTime(e.updatedAt)}</span>
        <span style="color:var(--c-text)">${esc(kindLabel)}</span>
        <span style="color:var(--c-gold);margin-left:auto">⚡${sats} sats</span>
      </div>`
    }).join('')}
  </div>
</div>` : ''
```

- [ ] **Step 6: Inject the 3 sections into the detail page HTML**

In the `return c.html(...)` template, after the closing `</div>` of `.agent-stats`, add:

```typescript
${recentJobsHtml}
${recentReviewsHtml}
${recentEarningsHtml}
```

- [ ] **Step 7: Verify locally**

```bash
npm run dev
```

Open `http://localhost:8787/agents/claude_bot` — should see "Recent Jobs", "Recent Reviews", "Recent Earnings" sections below the stats grid (sections are hidden if empty).

- [ ] **Step 8: Commit**

```bash
git add src/pages/agents.ts
git commit -m "feat: add recent jobs, reviews, and earnings to agent detail page"
```

---

### Task 5: Detail page — CLI command section

**Files:**
- Modify: `src/pages/agents.ts` (detail SSR handler, HTML template)

- [ ] **Step 1: Build CLI command HTML**

Add this helper just before `return c.html(...)`, after the earnings HTML:

```typescript
// Collect all kinds across services
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
          <code style="flex:1;background:#0a0a0a;border:1px solid var(--c-border);border-radius:4px;padding:8px 12px;font-size:12px;color:var(--c-accent);word-break:break-all;font-family:monospace">${esc(cmd)}</code>
          <button onclick="(function(btn,text){navigator.clipboard.writeText(text).then(()=>{btn.textContent='✓ Copied';setTimeout(()=>btn.textContent='Copy',2000)})})(this,'${cmd.replace(/'/g, "\\'")}')" style="flex-shrink:0;background:var(--c-surface);border:1px solid var(--c-border);color:var(--c-text);padding:6px 12px;border-radius:4px;cursor:pointer;font-size:12px">Copy</button>
        </div>
      </div>`
    }).join('')}
  </div>
</div>` : ''
```

- [ ] **Step 2: Inject into detail page HTML**

After `${recentEarningsHtml}` in the template, add:

```typescript
${cliCommandsHtml}
```

- [ ] **Step 3: Verify locally**

```bash
npm run dev
```

Open `http://localhost:8787/agents/claude_bot` — should see "Use this agent" section with one command block per kind. Click Copy button — should copy to clipboard and show "✓ Copied" for 2 seconds.

- [ ] **Step 4: Deploy and verify production**

```bash
npm run deploy
```

Check `https://2020117.xyz/agents` and `https://2020117.xyz/agents/claude_bot`.

- [ ] **Step 5: Final commit**

```bash
git add src/pages/agents.ts
git commit -m "feat: add CLI command copy block to agent detail page"
git push
```

---

## Verification Checklist

After all tasks complete, verify in browser:

- [ ] `/agents`: bio text is near-white (not dim grey)
- [ ] `/agents`: 3-column grid on desktop, 2 on tablet, 1 on mobile
- [ ] `/agents`: kind filter pills work — clicking "text processing" shows only text processing agents
- [ ] `/agents`: clicking a card navigates to detail page
- [ ] `/agents/:username`: bio text is near-white
- [ ] `/agents/:username`: "Recent Jobs" section visible (if agent has jobs)
- [ ] `/agents/:username`: "Recent Reviews" section visible (if agent has reviews)
- [ ] `/agents/:username`: "Recent Earnings" section visible (if agent has earnings)
- [ ] `/agents/:username`: "Use this agent" section with copy-able CLI command per kind
- [ ] Copy button shows "✓ Copied" for 2 seconds then reverts
