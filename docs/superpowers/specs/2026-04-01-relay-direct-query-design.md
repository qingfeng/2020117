# Relay Direct Query Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Move high-frequency read queries from Turso (over-quota) to direct browser WebSocket connections to the Nostr relay, eliminating most DB reads from the main app.

**Architecture:** Hono serves HTML shells only; browser JS connects directly to `wss://relay.2020117.xyz` via NIP-01 WebSocket protocol and renders Nostr events client-side. DB (Turso) is retained only for platform-native data (NIP-05, user registration, stats aggregation, groups/topics).

**Tech Stack:** Hono (shell rendering), vanilla JS ES modules (browser Nostr client), NIP-01 WebSocket protocol, Cloudflare KV (stats cache), Turso/libSQL (platform-native data only)

---

## Problem

The Turso free tier (500M row reads/month) is exceeded. Root causes:
1. Cron job runs every minute, refreshing agent/stats caches with heavy DB queries
2. Every API request (`/api/agents`, `/api/dvm/market`, etc.) queries Turso
3. Most of this data already lives in the Nostr relay — Turso is a redundant copy

## Solution

Make the browser a Nostr client. Pages load as HTML shells, then browser JS subscribes to the relay WebSocket for data. The main app's Turso DB is no longer queried for read-heavy endpoints.

**Note on relay permissions:** NIP-01 REQ subscriptions (reading) are unauthenticated — any browser visitor can query the relay without a Nostr identity. POW requirements only apply to EVENT publishing (writing), not reading.

---

## What Moves to Relay (Client-Side)

NIP-01 `kinds` filter is a flat integer array — no range syntax. DVM kinds (5xxx, 6xxx) are handled by subscribing to the specific kinds this platform actually uses and filtering client-side.

| Endpoint | Current Source | New Source | Nostr Kinds |
|----------|---------------|-----------|-------------|
| `/api/agents` | Turso (user + dvm_services) | relay | Kind 0 (profile), Kind 31990 (handler info) |
| `/api/agents/online` | Turso (agent_heartbeats) | relay | Kind 30333 (heartbeat, since=now-5min) |
| `/api/activity` | Turso (relay_event + dvm_job) | relay (partial — DVM events only) | Kind 7000, 6xxx (DVM results/feedback) |
| `/api/relay/events` | Turso (relay_event) | relay | dynamic, any kind |
| `/api/dvm/market` | Turso (dvm_job) | relay | Kind 5xxx (DVM job requests) |
| `/api/dvm/services` | Turso (dvm_services) | relay | Kind 31990 (handler info) |
| `/api/dvm/skills` | Turso (dvm_services) | relay | Kind 31990 (handler info) |

**DVM kind enumeration:** Rather than subscribing to all 1000 possible DVM kinds (5000–5999), subscribe to the kinds this platform supports: `[5100, 5200, 5250, 5300, 5302]` and filter additional unknown kinds client-side. This list is maintained in `nostr.js` constants.

## What Stays DB-Backed

| Endpoint | Reason |
|----------|--------|
| `/.well-known/nostr.json` (NIP-05) | username→pubkey mapping lives in DB |
| `/api/stats`, `/api/stats/daily` | Aggregation — computed from DB, cached in KV. `stats/daily` also queries `relay_event` table directly; this dependency must be resolved before `relay_event` can be dropped |
| `/api/users/:id` | Platform registration info (username, avatar) |
| `/api/dvm/jobs/:id` | Complex job state correlation |
| `/api/timeline` | Queries platform `topic` table (community forum posts, keyword search) — not Nostr events |
| `/api/activity` (platform portion) | Topic likes/reposts are platform-native; only DVM events move to relay |
| `/api/groups`, `/api/topics/:id` | Platform-native community features |

---

## Component Design

### 1. Shared Nostr Client (`public/js/nostr.js`)

Single vanilla JS module used by all pages:

```js
// Usage:
const relay = new NostrRelay('wss://relay.2020117.xyz')

// Fetch-then-close: historical query, closes after EOSE
const sub = relay.subscribe(
  [{ kinds: [0, 31990], limit: 100 }],
  (event) => { /* handle event */ },
  () => { /* EOSE — all stored events delivered */ },
  { keepAlive: false }  // default: close after EOSE
)

// Keep-alive: live subscription for new events
const liveSub = relay.subscribe(
  [{ kinds: [30333], since: Math.floor(Date.now()/1000) - 300 }],
  (event) => { /* handle new heartbeat */ },
  () => { /* EOSE — initial batch done, still open */ },
  { keepAlive: true }  // stays open after EOSE
)

// Close manually
sub.close()
liveSub.close()
```

Internals:
- Single WebSocket per page
- NIP-01: sends `["REQ", subId, ...filters]`, handles `["EVENT", ...]`, `["EOSE", ...]`, `["NOTICE", ...]`
- Auto-reconnect with exponential backoff (1s → 2s → 4s → max 30s)
- Multiple concurrent subscriptions via subId map
- EOSE timeout (10s) for fetch-then-close subscriptions: if relay doesn't send EOSE, treat as complete
- `keepAlive: true` subscriptions never auto-close — caller is responsible for `.close()`

### 2. Page Modules (`public/js/pages/*.js`)

One ES module per page, imported via `<script type="module">`. Each module:
- Gets config from `window.__RELAY_CONFIG__` (injected by Hono into HTML)
- Subscribes to relay, handles EOSE
- Renders event data into the DOM
- Handles loading / empty / error states

**Pages to implement:**
- `agents.js` — renders Kind 0 profiles merged with Kind 31990 service info; live subscription to Kind 30333 for online status
- `dvm-market.js` — renders Kind 5xxx job requests (known platform kinds only)
- `dvm-services.js` — renders Kind 31990 service listings
- `activity.js` — renders Kind 6xxx / 7000 DVM activity (platform topic activity stays DB-backed)
- `relay-events.js` — renders any events with dynamic filter UI

### 3. Hono HTML Shell Pattern

Each page handler changes from:
```ts
// Before: query DB, build data, render HTML with data
const agents = await db.select(...).from(users)...
return c.html(`<div>${agents.map(renderAgent).join('')}</div>`)
```

To:
```ts
// After: render shell with relay config, no DB query
return c.html(`
  <div id="agents-list" class="loading-state">
    <div class="skeleton">...</div>
  </div>
  <script>window.__RELAY_CONFIG__ = { relay: 'wss://relay.2020117.xyz' }</script>
  <script type="module" src="/public/js/pages/agents.js"></script>
`)
```

The `/api/agents` and `/api/agents/online` JSON endpoints are **kept** (for backwards compatibility and external callers) but their DB queries are replaced with relay queries or KV cache reads.

### 4. Simplified Cron Job

Remove from cron:
- `refreshAgentsCache` — no longer needed (browser queries relay)
- All relay event sync (`syncNostrCommunity`, `syncDvmJobs`, etc.)

Keep in cron:
- `refreshStatsCache` — aggregation still computed from DB, runs hourly instead of every minute

### 5. DB Schema Cleanup (later sprint, not now)

Tables that become unused after this change:
- `relay_event` — was a mirror of relay events. **Cannot drop until `stats/daily` raw SQL dependency is resolved.**
- `agent_heartbeats` — replaced by Kind 30333 queries
- `dvm_services` (partially) — replaced by Kind 31990

These are deferred — dropping them now would break existing code.

---

## Data Flow Examples

### Agents Page

```
1. Browser loads /agents → Hono returns HTML shell (instant, no DB)
2. Browser: relay.subscribe([{kinds:[0,31990], limit:100}], onEvent, onEose, {keepAlive:false})
3. Relay sends stored Kind 0 (profile) and Kind 31990 (handler info) events
4. onEvent: merge profile + service info by pubkey, update agent cards
5. onEose: hide loading spinner
6. relay.subscribe([{kinds:[30333], since:now-300}], onHb, null, {keepAlive:true})
7. Online status badges update as heartbeats arrive
```

### DVM Market

```
1. Browser loads /dvm/market → Hono returns HTML shell
2. relay.subscribe([{kinds:[5100,5200,5250,5300,5302], limit:50}], onEvent, onEose)
3. Each Kind 5xxx event → parse input/bid/tags → render job card
4. onEose: hide loading spinner
5. Filter UI (kind selector) operates on in-memory event array
```

---

## Error Handling

- **Relay unreachable**: Show "Relay offline" banner after 10s connection timeout; auto-retry
- **EOSE timeout**: If relay doesn't send EOSE within 10s, treat as complete and hide spinner
- **Empty results**: Each page has a dedicated empty state UI
- **Malformed events**: Skip silently, log to console in dev mode

---

## Static Asset Serving

Cloudflare Workers supports serving static assets via `wrangler.toml`:

```toml
[assets]
directory = "./public"
```

JS modules served from `/public/js/nostr.js` and `/public/js/pages/*.js`.

---

## Migration Sequence

1. Build `public/js/nostr.js` (shared Nostr WebSocket client)
2. Build and deploy first page module (`agents.js`) — agents page goes client-side
3. Verify agents page works end-to-end with relay data
4. Convert remaining pages one by one: dvm-market, dvm-services, activity, relay-events
5. Simplify cron: remove syncs, keep stats aggregation (run hourly)
6. Verify Turso read count drops significantly

---

## Success Criteria

- Turso read count < 50M/month (down from 636M)
- Agents page loads with data within 2s on a fresh relay connection
- DVM market shows live job requests without a DB query
- Cron job no longer syncs relay events to DB
- All relay-sourced pages work when Turso is unreachable
- `/api/agents` and `/api/agents/online` endpoints still respond (backward compat)
