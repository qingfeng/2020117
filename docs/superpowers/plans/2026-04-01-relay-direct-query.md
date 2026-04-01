# Relay Direct Query Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Turso DB reads on high-traffic pages with browser-side WebSocket queries direct to `wss://relay.2020117.xyz`, eliminating ~600M monthly reads and fixing the over-quota outage.

**Architecture:** Hono pages stay as-is (HTML template strings); the inline `<script>` blocks are modified to use a shared `NostrRelay` JS client instead of `fetch('/api/...')`. A new `src/lib/nostr-client.ts` exports `NOSTR_CLIENT_JS` (a JS string constant, same pattern as `BEAM_AVATAR_JS`). Cron pollers that synced relay events into DB are removed.

**Tech Stack:** TypeScript, Hono, vanilla JS (inline in pages), NIP-01 WebSocket protocol, Cloudflare Workers

---

## File Structure

| File | Change | Reason |
|------|--------|--------|
| `src/lib/nostr-client.ts` | **Create** | `NOSTR_CLIENT_JS` constant — shared WebSocket client embedded in pages |
| `src/pages/relay.ts` | **Modify** | Replace `fetch('/api/relay/events')` with relay subscription |
| `src/pages/market.ts` | **Modify** | Replace `fetch('/api/dvm/market')` with relay subscription |
| `src/pages/agents.ts` | **Modify** | Replace `fetch('/api/agents')` with relay subscription |
| `src/cron.ts` | **Modify** | Remove relay sync pollers (pollRelayEvents, pollHeartbeats, pollExternalDvms, pollPublicRelayForUsers, refreshAgentsCache) |

---

## Task 1: Create NOSTR_CLIENT_JS utility

**Files:**
- Create: `src/lib/nostr-client.ts`

**Context:** This is the shared WebSocket client that all pages embed inline, just like `BEAM_AVATAR_JS` in `src/lib/avatar.ts`. It creates `window.nostrRelay` with two methods: `init(url)` and `subscribe(filters, onEvent, onEose, opts)`.

- [ ] **Step 1: Create `src/lib/nostr-client.ts`**

```typescript
/**
 * NOSTR_CLIENT_JS — browser-side NIP-01 WebSocket client.
 * Embed inline in page scripts: `${NOSTR_CLIENT_JS}`
 * Usage:
 *   nostrRelay.init('wss://relay.2020117.xyz')
 *   const sub = nostrRelay.subscribe([{kinds:[0],limit:50}], onEvent, onEose)
 *   const liveSub = nostrRelay.subscribe([{kinds:[30333],since:now-300}], onEvent, null, {live:true})
 *   sub.close()
 */
export const NOSTR_CLIENT_JS = `(function(){
var _ws,_url,_subs=new Map(),_cnt=0,_delay=1000;
function _conn(){
  _ws=new WebSocket(_url);
  _ws.onopen=function(){
    _delay=1000;
    _subs.forEach(function(e,id){
      _ws.send(JSON.stringify(['REQ',id].concat(e.filters)));
    });
  };
  _ws.onmessage=function(m){
    var msg;try{msg=JSON.parse(m.data);}catch{return;}
    if(!Array.isArray(msg))return;
    var s=_subs.get(msg[1]);
    if(msg[0]==='EVENT'&&s)s.onEvent&&s.onEvent(msg[2]);
    if(msg[0]==='EOSE'&&s){
      clearTimeout(s.timer);
      s.onEose&&s.onEose();
      if(!s.live){_subs.delete(msg[1]);if(_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',msg[1]]));}
    }
  };
  _ws.onclose=function(){setTimeout(_conn,_delay);_delay=Math.min(_delay*2,30000);};
  _ws.onerror=function(){};
}
window.nostrRelay={
  init:function(url){_url=url;_conn();},
  subscribe:function(filters,onEvent,onEose,opts){
    opts=opts||{};
    var id='r'+(++_cnt);
    var timer=opts.live?null:setTimeout(function(){
      var s=_subs.get(id);
      if(s){s.onEose&&s.onEose();_subs.delete(id);if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',id]));}
    },opts.timeout||10000);
    _subs.set(id,{filters:filters,onEvent:onEvent,onEose:onEose,live:!!opts.live,timer:timer});
    if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['REQ',id].concat(filters)));
    return{close:function(){clearTimeout(timer);_subs.delete(id);if(_ws&&_ws.readyState===1)_ws.send(JSON.stringify(['CLOSE',id]));}};
  }
};
})();`
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/qingfeng/Desktop/2020117
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors from `src/lib/nostr-client.ts`

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostr-client.ts
git commit -m "feat: add NOSTR_CLIENT_JS shared WebSocket client utility"
```

---

## Task 2: Convert timeline page to relay WebSocket

**Files:**
- Modify: `src/pages/relay.ts` (lines ~234–259 — the `loadPage()` function and script block)

**Context:** The `/timeline-legacy` page currently calls `fetch('/api/relay/events?...')` which hits Turso's `relay_event` table. Replace with relay WebSocket subscription. Raw Nostr events have shape `{id, pubkey, kind, content, created_at, tags, sig}` — different from the DB row shape the page currently expects. We adapt `renderCard` to use raw events + a profile cache.

The existing `renderCard(ev)` uses: `ev.kind`, `ev.event_id`, `ev.pubkey`, `ev.display_name`, `ev.username`, `ev.avatar_url`, `ev.content_preview`, `ev.event_created_at`, `ev.detail`. We'll normalize raw events to a compatible shape.

Filter tabs map (explicit kind lists — no range notation):
- "All" → kinds `[1, 5100, 5200, 5250, 5300, 5301, 5302, 5303, 6100, 6200, 6250, 6300, 6302, 6303, 7000]`
- "Jobs" → kinds `[5100, 5200, 5250, 5300, 5301, 5302, 5303]`
- "Completed" → kinds `[6100, 6200, 6250, 6300, 6302, 6303]`
- "Notes" → kind `[1]`

- [ ] **Step 1: Open `src/pages/relay.ts` and locate the script block**

The script section starts around line 103 with `<script>`. The key parts to change:
- Add `${NOSTR_CLIENT_JS}` and the relay `init` call
- Replace `loadPage()` and `setFilter()` functions
- Adapt `getAvatar()` to use profile cache
- Replace pagination controls with an "older" button

- [ ] **Step 2: Add import at top of relay.ts**

Add to the existing imports at the top of the file:
```typescript
import { NOSTR_CLIENT_JS } from '../lib/nostr-client'
```

Note: `NOTE_RENDER_JS` is **already imported** in relay.ts (line 4: `import { ..., NOTE_RENDER_JS } from './shared-styles'`). No new import needed for it.

- [ ] **Step 3: Replace the script block in `/timeline-legacy` route**

Find the `<script>` block (starts with `${BEAM_AVATAR_JS}` around line 103) and replace the entire script content. The new script:

```javascript
// Add NOSTR_CLIENT_JS to the script block inline, then replace loadPage/setFilter:
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
```

Also add `const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'` to the route handler (server-side TypeScript, before the HTML template).

- [ ] **Step 4: Verify the page builds**

```bash
npm run dev 2>&1 | head -20
```
Expected: wrangler dev starts without TypeScript errors

- [ ] **Step 5: Manual test in browser**

Open `http://localhost:8787/timeline-legacy` in browser.
Expected: page loads, events appear within ~2s from relay WebSocket, filter tabs work

- [ ] **Step 6: Deploy and verify**

```bash
npm run deploy 2>&1 | tail -10
```

```bash
curl -s --max-time 15 https://2020117.xyz/timeline-legacy | grep -c "Loading"
```
Expected: 1 (the loading placeholder appears in HTML, data filled client-side)

- [ ] **Step 7: Commit**

```bash
git add src/pages/relay.ts
git commit -m "feat: convert timeline page to relay WebSocket — eliminates relay_event DB reads"
```

---

## Task 3: Convert DVM market page to relay WebSocket

**Files:**
- Modify: `src/pages/market.ts` (the `loadJobs()` function and script block, lines ~80–200)

**Context:** The market page calls `fetch('/api/dvm/market?status=open&limit=30&page=1')` which queries the `dvm_job` Turso table. We replace this with relay subscriptions.

**Status tab simplification:**
- "Requests" tab → subscribe Kind 5100, 5200, 5250, 5300, 5301, 5302, 5303
- "Results" tab → subscribe Kind 6100, 6200, 6250, 6300, 6302, 6303
- Remove "Processing" tab (can't reliably determine from relay events alone)

**Data mapping from raw Kind 5xxx event to job row:**
- `input`: from `["i", value]` tag or `content` field
- `bid_sats`: from `["bid", msats]` tag ÷ 1000
- `kind`: `event.kind`
- `customer`: from profile cache (pubkey → {name, picture})

- [ ] **Step 1: Add NOSTR_CLIENT_JS import to market.ts**

```typescript
import { NOSTR_CLIENT_JS } from '../lib/nostr-client'
```

- [ ] **Step 2: Add `relayUrl` to the route handler (server-side TypeScript)**

In the `router.get('/dvm/market', (c) => {` handler body, add before the template:
```typescript
const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
```

- [ ] **Step 3: Replace the `scripts` const in market.ts**

Before replacing, verify in market.ts HTML template that:
- The "Open" tab element has class `tab-open` (used for detection in tab switching code below)
- The "Completed" tab has class `tab-completed`

The current script (lines ~80–200) replaces `loadJobs()` with relay subscription. Replace the entire `const scripts = \`<script>...\`` value with:

```javascript
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
  var list = document.getElementById('job-list');
  list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--c-text-muted);font-size:14px">${t.marketLoading}</div>';

  var requestKinds = [5100,5200,5250,5300,5301,5302,5303];
  var resultKinds  = [6100,6200,6250,6300,6302,6303];
  var loadKinds = currentTab === 'results' ? resultKinds : requestKinds;
  var batchPubkeys = [];

  nostrRelay.subscribe(
    [{ kinds: loadKinds, limit: 50 }],
    function(ev) {
      var job = eventToJob(ev);
      if (currentTab === 'results') {
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
          function(ev) { try { var p = JSON.parse(ev.content); profileCache[ev.pubkey] = p; } catch {} },
          function() { renderJobs(); }
        );
      } else {
        renderJobs();
      }
    }
  );
}

// Tab switching — replace old status tabs
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
```

- [ ] **Step 4: Verify the page builds**

```bash
npm run dev 2>&1 | head -20
```
Expected: starts without errors

- [ ] **Step 5: Manual test**

Open `http://localhost:8787/dvm/market` in browser.
Expected: job requests appear, tab switching works, job rows link to `/jobs/:id`

- [ ] **Step 6: Deploy**

```bash
npm run deploy 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/market.ts
git commit -m "feat: convert DVM market page to relay WebSocket"
```

---

## Task 4: Convert agents page to relay WebSocket

**Files:**
- Modify: `src/pages/agents.ts` (the `load()` and `loadStats()` functions, lines ~155–264)

**Context:** The agents page calls `fetch('/api/agents?limit=50')` which either hits the KV cache or triggers `refreshAgentsCache` (heavy Turso query). New approach: subscribe to Kind 31990 (handler info) to discover agents, then batch-fetch their Kind 0 profiles, then subscribe to Kind 30333 for live online status.

**Data mapping:**
- Agent list: from Kind 31990 events (one per agent, indexed by pubkey)
- Profile (name, bio, picture): from Kind 0 event for same pubkey
- Kinds/services: from Kind 31990 tags `["k", "5100"]` etc.
- Online status: from Kind 30333 events `since: now - 300s` (keep-alive subscription)

**What we lose:** `reputation` scores, `completed_jobs_count`, `earned_sats`, `avg_rating` — these are DB-computed. Remove those stat chips from the agent card for now.

**What we keep:** name, bio, avatar, service kinds, online status, pricing (from Kind 30333 content).

- [ ] **Step 1: Add import to agents.ts**

```typescript
import { NOSTR_CLIENT_JS } from '../lib/nostr-client'
```

- [ ] **Step 2: Add `relayUrl` to the route handler**

In `router.get('/agents', (c) => {` body, before the template:
```typescript
const relayUrl = c.env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
```

- [ ] **Step 3: Replace the `load()` and `loadStats()` functions in the scripts const**

The retained code block (keep as-is): everything from `${BEAM_AVATAR_JS}` down through and including the sort/filter event listeners (the `document.getElementById('sortBtns').addEventListener` and `document.getElementById('kindPills').addEventListener` blocks), plus the existing `let allAgentsCache=[];`, `let selectedKind=0;`, `let selectedSort='reputation';`, `SORT_FNS`, `filterAgents()`, `renderAgents()`, `cardKey()`, `esc()` declarations.

Replace only the `async function load()` and `async function loadStats()` functions and the final `load(); loadStats();` call at the end with the following. Note: `${NOSTR_CLIENT_JS}` goes at the start of the replacement block, AFTER the retained `let allAgentsCache` declaration — so `allAgentsCache` is already in scope when the new `load()` uses it.

```javascript
${NOSTR_CLIENT_JS}
nostrRelay.init('${relayUrl}');

var agentMap = {};      // pubkey → agent data
var onlinePubkeys = {}; // pubkey → true if heartbeat seen in last 5min

const KIND_LABEL_MAP = {
  5100:'Text Processing', 5200:'Image Gen', 5250:'Text-to-Speech',
  5300:'Content Discovery', 5301:'Speech-to-Text', 5302:'Translation', 5303:'Summarization',
};

function mergeServiceEvent(ev) {
  var pub = ev.pubkey;
  if (!agentMap[pub]) agentMap[pub] = { pubkey: pub, kinds: [], services: [], live: false };
  var a = agentMap[pub];
  var kinds = ev.tags.filter(function(t){return t[0]==='k';}).map(function(t){return parseInt(t[1],10);}).filter(Boolean);
  if (kinds.length) a.kinds = kinds;
  a.services = [{ kinds: kinds, kind_labels: kinds.map(function(k){return KIND_LABEL_MAP[k]||'Kind '+k;}) }];
  try {
    var c = JSON.parse(ev.content);
    if (c.name) a.display_name = c.name;
    if (c.about) a.bio = c.about;
    if (c.picture) a.avatar_url = c.picture;
  } catch {}
}

function mergeProfileEvent(ev) {
  var pub = ev.pubkey;
  if (!agentMap[pub]) agentMap[pub] = { pubkey: pub, kinds: [], services: [], live: false };
  var a = agentMap[pub];
  try {
    var c = JSON.parse(ev.content);
    if (c.name) a.display_name = c.name;
    if (c.about) a.bio = c.about;
    if (c.picture) a.avatar_url = c.picture;
    if (c.lud16) a.lud16 = c.lud16;
  } catch {}
}

function buildAgentList() {
  return Object.values(agentMap).filter(function(a){
    return a.kinds && a.kinds.length > 0;
  }).map(function(a){
    return Object.assign({}, a, { live: !!onlinePubkeys[a.pubkey] });
  });
}

function load() {
  var el = document.getElementById('agents');
  el.innerHTML = '<div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px;margin-bottom:12px"></div><div class="skeleton" style="height:80px"></div>';

  var agentPubkeys = [];

  // 1. Fetch Kind 31990 (handler/service registrations)
  nostrRelay.subscribe(
    [{ kinds: [31990], limit: 100 }],
    function(ev) {
      mergeServiceEvent(ev);
      if (agentPubkeys.indexOf(ev.pubkey) < 0) agentPubkeys.push(ev.pubkey);
    },
    function() {
      // 2. Batch fetch Kind 0 profiles for all discovered pubkeys
      if (!agentPubkeys.length) { allAgentsCache = []; renderAgents(allAgentsCache); return; }
      nostrRelay.subscribe(
        [{ kinds: [0], authors: agentPubkeys, limit: agentPubkeys.length }],
        function(ev) { mergeProfileEvent(ev); },
        function() {
          allAgentsCache = buildAgentList();
          renderAgents(allAgentsCache);
          loadStats();
        }
      );
    }
  );

  // 3. Keep-alive subscription for online heartbeats (Kind 30333, last 5 min)
  var now = Math.floor(Date.now()/1000);
  nostrRelay.subscribe(
    [{ kinds: [30333], since: now - 300 }],
    function(ev) {
      onlinePubkeys[ev.pubkey] = true;
      // Update live badge if card already rendered
      Object.values(agentMap).forEach(function(a){
        if (a.pubkey === ev.pubkey) a.live = true;
      });
      allAgentsCache = buildAgentList();
      renderAgents(allAgentsCache);
      loadStats(); // update online count in stats bar
    },
    null,
    { live: true }
  );
}

function loadStats() {
  try {
    var onlineCount = Object.keys(onlinePubkeys).length;
    var bar = document.getElementById('stats-bar');
    if (bar) bar.innerHTML =
      '<span><span class="status-dot dot-live"></span><strong>' + onlineCount + '</strong> ${t.online}</span>'
      + '<span><strong>' + Object.keys(agentMap).length + '</strong> agents</span>';
  } catch(e) {}
}

load();
```

Note: Keep the existing `allAgentsCache`, `selectedKind`, `selectedSort`, `SORT_FNS`, `filterAgents()`, `renderAgents()`, `cardKey()` code and the sort/filter event listeners — those don't need to change. Only replace the `load()` and `loadStats()` functions.

- [ ] **Step 4: Remove reputation stat chips from `renderAgents`**

In the existing `renderAgents` function, the `stats` variable builds reputation chips. Since we no longer have reputation data from relay, simplify: remove the `completedJobs`, `earnedSats`, `avgRating` references. Replace `const stats = ...` with:

```javascript
const stats = a.pricing_min ? '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--c-border)"><div class="agent-pricing">\u26a1 ' + Math.floor(a.pricing_min/1000) + ' ${t.agentSatsPerJob}</div></div>' : '';
```

- [ ] **Step 5: Verify and test**

```bash
npm run dev 2>&1 | head -20
```

Open `http://localhost:8787/agents` — agents should load from relay within 2s.
Expected: agent cards show names/bios/service kinds; online badge appears for active agents

- [ ] **Step 6: Deploy**

```bash
npm run deploy 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/agents.ts
git commit -m "feat: convert agents page to relay WebSocket — eliminates refreshAgentsCache DB reads"
```

---

## Task 5: Simplify cron — remove relay sync pollers

**Files:**
- Modify: `src/cron.ts`

**Context:** The cron job runs every minute and includes ~15 pollers. Several of these sync relay events into Turso tables that the converted pages no longer need:
- `pollRelayEvents` → wrote to `relay_event` table; timeline page no longer reads it
- `pollHeartbeats` → wrote to `agent_heartbeats` table; agents/online page no longer reads it
- `pollExternalDvms` → wrote to `dvm_services` table for external DVMs; agents page no longer reads it
- `pollPublicRelayForUsers` → synced external posts for platform users; no page needs it now
- `refreshAgentsCache` → built KV cache from DB; agents page no longer uses it

Remove these 5 items from cron. Keep all others (they're needed for job detail pages, user profiles, reputation, WoT, community).

- [ ] **Step 1: Remove the 5 pollers from `src/cron.ts`**

Delete these try/catch blocks entirely:

```typescript
// DELETE this block (~lines 151-157):
try {
  const { pollRelayEvents } = await import('./services/dvm')
  await pollRelayEvents(env, db)
} catch (e) {
  console.error('[Cron] Relay event poll failed:', e)
}

// DELETE this block (~lines 119-125):
try {
  const { pollHeartbeats } = await import('./services/dvm')
  await pollHeartbeats(env, db)
} catch (e) {
  console.error('[Cron] Heartbeat poll failed:', e)
}

// DELETE this block (~lines 103-109):
try {
  const { pollExternalDvms } = await import('./services/dvm')
  await pollExternalDvms(env, db)
} catch (e) {
  console.error('[Cron] External DVM poll failed:', e)
}

// DELETE this block (~lines 167-173):
try {
  const { pollPublicRelayForUsers } = await import('./services/dvm')
  await pollPublicRelayForUsers(env, db)
} catch (e) {
  console.error('[Cron] Public relay user sync failed:', e)
}
```

**5th removal — `refreshAgentsCache`:** Near the end of cron, find the cache refresh block and remove `refreshAgentsCache`:

```typescript
// DELETE from import destructure — change:
const { refreshAgentsCache, refreshStatsCache } = await import('./services/cache')
// TO:
const { refreshStatsCache } = await import('./services/cache')

// DELETE refreshAgentsCache call — change:
await Promise.all([
  refreshAgentsCache(env, db),
  refreshStatsCache(env, db),
])
// TO:
await refreshStatsCache(env, db)
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: no errors

- [ ] **Step 3: Deploy**

```bash
npm run deploy 2>&1 | tail -5
```

- [ ] **Step 4: Verify cron no longer errors on removed pollers**

```bash
npx wrangler tail --format=pretty 2>&1 &
sleep 70  # wait for one cron tick
```
Expected: No `[Cron] Relay event poll failed` / `Heartbeat poll failed` / `External DVM poll failed` lines

- [ ] **Step 5: Commit**

```bash
git add src/cron.ts
git commit -m "feat: remove relay sync pollers from cron — relay events now fetched client-side"
```

---

## Final Verification

After all 5 tasks:

- [ ] Visit `https://2020117.xyz/agents` — agents load from relay, no DB errors
- [ ] Visit `https://2020117.xyz/dvm/market` — job requests show from relay
- [ ] Visit `https://2020117.xyz/timeline-legacy` — event feed shows from relay
- [ ] Visit `https://2020117.xyz/api/stats` — still returns stats (DB-backed, KV cached)
- [ ] Check Turso dashboard after 1 hour — read count should be drastically lower
- [ ] `npx wrangler tail` during page loads — no `Failed query` errors
