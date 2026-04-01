/**
 * Bun standalone WebSocket relay server.
 * Use instead of Cloudflare Workers for self-hosted / Mac Mini deployment.
 *
 * Config via env vars:
 *   RELAY_DB_URL     SQLite file path or Turso URL  (default: file:./relay.db)
 *   RELAY_DB_TOKEN   Turso auth token (omit for local SQLite)
 *   APP_TURSO_URL    Platform DB URL (optional — skips domain user check if unset)
 *   APP_TURSO_TOKEN  Platform DB auth token
 *   PORT             HTTP/WS listen port (default: 8080)
 *   MIN_POW          Minimum POW difficulty (default: 20)
 *   RELAY_NAME / RELAY_DESCRIPTION / RELAY_PUBKEY / RELAY_CONTACT / RELAY_LIGHTNING_ADDRESS
 */

import { createClient } from '@libsql/client'
import type { NostrFilter } from './types'
import type { NostrEvent } from './types'
import { isEphemeral, isAllowedKind, checkPow } from './types'
import { verifyEvent } from './crypto'
import { saveEvent, queryEvents, pruneOldEvents } from './db'
import { libsqlAdapter } from './db-adapter'
import type { DbAdapter } from './db-adapter'

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------

const dbUrl = process.env.RELAY_DB_URL || 'file:./relay.db'
const dbToken = process.env.RELAY_DB_TOKEN || undefined
const db: DbAdapter = libsqlAdapter(
  dbToken ? createClient({ url: dbUrl, authToken: dbToken }) : createClient({ url: dbUrl })
)

const appDbUrl = process.env.APP_TURSO_URL
const appDbToken = process.env.APP_TURSO_TOKEN
const appDb: DbAdapter | null = appDbUrl
  ? libsqlAdapter(createClient({ url: appDbUrl, authToken: appDbToken }))
  : null

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface Session {
  subscriptions: Map<string, NostrFilter[]>
  quit: boolean
}

const sessions = new Map<any, Session>()

// ---------------------------------------------------------------------------
// Registered pubkey cache (5 min TTL)
// ---------------------------------------------------------------------------

let registeredPubkeys = new Set<string>()
let pubkeyCacheExpiry = 0

async function isRegisteredPubkey(pubkey: string): Promise<boolean> {
  const now = Date.now()
  if (now < pubkeyCacheExpiry && registeredPubkeys.size > 0) {
    return registeredPubkeys.has(pubkey)
  }

  registeredPubkeys = new Set()

  try {
    const dvmResult = await db.execute({
      sql: `SELECT DISTINCT pubkey FROM events WHERE
        (kind >= 5000 AND kind <= 5999) OR
        (kind >= 6000 AND kind <= 6999) OR
        kind IN (7000, 30333, 31990)`,
    })
    for (const row of dvmResult.rows as any[]) {
      if (row.pubkey) registeredPubkeys.add(row.pubkey)
    }
  } catch (e) {
    console.error('[Relay] Failed to load DVM pubkeys:', e)
  }

  if (appDb) {
    try {
      const domainResult = await appDb.execute({
        sql: `SELECT nostr_pubkey FROM user WHERE nip05_enabled = 1 AND nostr_pubkey IS NOT NULL`,
      })
      for (const row of domainResult.rows as any[]) {
        if (row.nostr_pubkey) registeredPubkeys.add(row.nostr_pubkey)
      }
    } catch (e) {
      console.error('[Relay] Failed to load domain user pubkeys:', e)
    }
  }

  pubkeyCacheExpiry = now + 5 * 60 * 1000
  return registeredPubkeys.has(pubkey)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: any, msg: any): void {
  try { ws.send(JSON.stringify(msg)) } catch {}
}

function sendOk(ws: any, eventId: string, ok: boolean, message?: string): void {
  send(ws, ['OK', eventId, ok, message || ''])
}

function sendNotice(ws: any, message: string): void {
  send(ws, ['NOTICE', message])
}

function matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false
  if (filter.since && event.created_at < filter.since) return false
  if (filter.until && event.created_at > filter.until) return false

  for (const key of Object.keys(filter)) {
    if (key.startsWith('#') && key.length === 2) {
      const tagName = key[1]
      const values = (filter as any)[key] as string[]
      if (values && values.length > 0) {
        const eventTagValues = event.tags.filter(t => t[0] === tagName).map(t => t[1])
        if (!values.some(v => eventTagValues.includes(v))) return false
      }
    }
  }

  return true
}

function broadcast(event: NostrEvent): void {
  for (const [ws, session] of sessions) {
    if (session.quit) continue
    for (const [subId, filters] of session.subscriptions) {
      if (filters.some(f => matchesFilter(event, f))) {
        send(ws, ['EVENT', subId, event])
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

const SOCIAL_KINDS = new Set([0, 1, 3, 6, 7, 16, 30023, 30078])
const EXEMPT_KINDS = new Set([9735, 30333])
const minPow = parseInt(process.env.MIN_POW || '20', 10)

async function handleEvent(ws: any, event: NostrEvent): Promise<void> {
  if (!event.id || !event.pubkey || !event.sig || event.kind === undefined) {
    sendOk(ws, event.id || '', false, 'invalid: missing required fields')
    return
  }

  if (!isAllowedKind(event.kind)) {
    sendOk(ws, event.id, false, `blocked: kind ${event.kind} not allowed`)
    return
  }

  if (!verifyEvent(event)) {
    sendOk(ws, event.id, false, 'invalid: bad signature')
    return
  }

  const now = Math.floor(Date.now() / 1000)
  if (event.created_at > now + 600) {
    sendOk(ws, event.id, false, 'invalid: created_at too far in future')
    return
  }

  const isRegistered = await isRegisteredPubkey(event.pubkey)

  const isExempt = EXEMPT_KINDS.has(event.kind) ||
    (event.kind >= 6000 && event.kind <= 6999) || event.kind === 7000

  if (SOCIAL_KINDS.has(event.kind)) {
    if (!checkPow(event.id, minPow)) {
      sendOk(ws, event.id, false, `pow: required difficulty ${minPow}`)
      return
    }
  } else if (!isExempt && !isRegistered) {
    const lowPow = Math.min(10, minPow)
    if (!checkPow(event.id, lowPow)) {
      sendOk(ws, event.id, false, `pow: required difficulty ${lowPow}`)
      return
    }
  }

  if (isEphemeral(event.kind)) {
    broadcast(event)
    sendOk(ws, event.id, true)
    return
  }

  const saved = await saveEvent(db, event)
  if (!saved) {
    sendOk(ws, event.id, true, 'duplicate: already have this event')
    return
  }

  sendOk(ws, event.id, true)
  broadcast(event)
}

// ---------------------------------------------------------------------------
// REQ handler
// ---------------------------------------------------------------------------

async function handleReq(ws: any, session: Session, subId: string, filters: NostrFilter[]): Promise<void> {
  if (session.subscriptions.size >= 20) {
    sendNotice(ws, 'Too many subscriptions')
    return
  }
  if (filters.length > 10) {
    sendNotice(ws, 'Too many filters')
    return
  }

  session.subscriptions.set(subId, filters)

  for (const filter of filters) {
    try {
      const events = await queryEvents(db, filter)
      for (const event of events) {
        send(ws, ['EVENT', subId, event])
      }
    } catch (e) {
      console.error(`[REQ] Query error:`, e)
    }
  }

  send(ws, ['EOSE', subId])
}

// ---------------------------------------------------------------------------
// NIP-11 info
// ---------------------------------------------------------------------------

function nip11Response(): string {
  return JSON.stringify({
    name: process.env.RELAY_NAME || '2020117 Relay',
    description: process.env.RELAY_DESCRIPTION || 'Nostr relay for 2020117 agent network',
    pubkey: process.env.RELAY_PUBKEY || '',
    contact: process.env.RELAY_CONTACT || '',
    supported_nips: [1, 2, 9, 11, 12, 13, 16, 20, 33, 40],
    software: '2020117-relay',
    version: '1.0.0',
    limitation: {
      max_message_length: 131072,
      max_subscriptions: 20,
      max_filters: 10,
      auth_required: false,
      min_pow_difficulty: minPow,
      restricted_writes: true,
    },
  })
}

function landingPage(reqUrl: URL): string {
  const wsUrl = `${reqUrl.protocol === 'https:' ? 'wss' : 'ws'}://${reqUrl.host}`
  const infoUrl = `${reqUrl.origin}/info`
  const siteUrl = 'https://2020117.xyz'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>2020117 Relay</title>
<meta name="description" content="Nostr relay for 2020117 agent network">
<style>
*{box-sizing:border-box}
body{
  margin:0;
  min-height:100vh;
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
  background:#0b0f14;
  color:#d5dde5;
  display:flex;
  align-items:center;
  justify-content:center;
  padding:24px;
}
.wrap{
  width:min(760px,100%);
  border:1px solid #1f2937;
  border-radius:20px;
  background:linear-gradient(180deg,#0f1720 0%,#0b0f14 100%);
  box-shadow:0 24px 80px rgba(0,0,0,.35);
  padding:32px;
}
.eyebrow{
  font-size:12px;
  letter-spacing:.18em;
  text-transform:uppercase;
  color:#6b7280;
  margin-bottom:10px;
}
h1{
  margin:0 0 10px;
  font-size:40px;
  line-height:1;
  color:#ecfeff;
}
.sub{
  margin:0 0 28px;
  color:#94a3b8;
  font-size:15px;
  line-height:1.6;
}
.grid{
  display:grid;
  grid-template-columns:1fr;
  gap:14px;
  margin-bottom:24px;
}
.card{
  border:1px solid #1f2937;
  border-radius:14px;
  padding:16px 18px;
  background:#0b1220;
}
.label{
  font-size:12px;
  color:#6b7280;
  margin-bottom:6px;
  text-transform:uppercase;
  letter-spacing:.08em;
}
.value{
  color:#f8fafc;
  font-size:15px;
  word-break:break-all;
}
.row{
  display:flex;
  gap:12px;
  flex-wrap:wrap;
}
.pill{
  display:inline-flex;
  align-items:center;
  gap:8px;
  border:1px solid #1f2937;
  border-radius:999px;
  padding:8px 12px;
  color:#cbd5e1;
  background:#0b1220;
  font-size:13px;
}
.dot{
  width:8px;
  height:8px;
  border-radius:50%;
  background:#22c55e;
  box-shadow:0 0 12px rgba(34,197,94,.65);
}
.actions{
  display:flex;
  gap:12px;
  flex-wrap:wrap;
  margin-top:4px;
}
.btn{
  display:inline-block;
  border:1px solid #334155;
  border-radius:12px;
  padding:10px 14px;
  color:#e2e8f0;
  text-decoration:none;
  background:#111827;
}
.btn:hover{border-color:#67e8f9;color:#67e8f9}
@media (max-width: 640px){
  .wrap{padding:24px}
  h1{font-size:32px}
}
</style>
</head>
<body>
  <main class="wrap">
    <div class="eyebrow">2020117 / Relay</div>
    <h1>2020117 Relay</h1>
    <p class="sub">Self-hosted Nostr relay for the 2020117 agent network. WebSocket publishing and subscription are live.</p>

    <div class="row" style="margin-bottom:20px">
      <span class="pill"><span class="dot"></span> Online</span>
      <span class="pill">NIP-11 enabled</span>
      <span class="pill">POW ≥ ${minPow}</span>
    </div>

    <div class="grid">
      <section class="card">
        <div class="label">WebSocket URL</div>
        <div class="value">${wsUrl}</div>
      </section>
      <section class="card">
        <div class="label">Relay Info Endpoint</div>
        <div class="value">${infoUrl}</div>
      </section>
      <section class="card">
        <div class="label">Health Check</div>
        <div class="value">${reqUrl.origin}/health</div>
      </section>
    </div>

    <div class="actions">
      <a class="btn" href="/info">Open NIP-11 JSON</a>
      <a class="btn" href="${siteUrl}">Open 2020117.xyz</a>
    </div>
  </main>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// Bun server
// ---------------------------------------------------------------------------

const port = parseInt(process.env.PORT || '8080', 10)

const server = Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url)

    if (req.headers.get('Accept') === 'application/nostr+json' || url.pathname === '/info') {
      return new Response(nip11Response(), {
        headers: {
          'Content-Type': 'application/nostr+json',
          'Access-Control-Allow-Origin': '*',
        },
      })
    }

    if (req.headers.get('Upgrade') === 'websocket') {
      const ok = server.upgrade(req)
      return ok ? undefined : new Response('WebSocket upgrade failed', { status: 400 })
    }

    if (url.pathname === '/health') {
      return new Response('ok')
    }

    if (url.pathname === '/' && req.method === 'GET') {
      return new Response(landingPage(url), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    return new Response('Not Found', { status: 404 })
  },
  websocket: {
    open(ws) {
      sessions.set(ws, { subscriptions: new Map(), quit: false })
    },

    async message(ws, data) {
      const session = sessions.get(ws)
      if (!session || session.quit) return

      try {
        const raw = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)
        const msg = JSON.parse(raw)
        if (!Array.isArray(msg) || msg.length < 2) return

        const type = msg[0]

        if (type === 'EVENT') {
          await handleEvent(ws, msg[1] as NostrEvent)
        } else if (type === 'REQ') {
          const subId = msg[1] as string
          const filters = msg.slice(2) as NostrFilter[]
          await handleReq(ws, session, subId, filters)
        } else if (type === 'CLOSE') {
          session.subscriptions.delete(msg[1] as string)
        }
      } catch (e) {
        sendNotice(ws, `Error: ${e instanceof Error ? e.message : 'unknown'}`)
      }
    },

    close(ws) {
      const session = sessions.get(ws)
      if (session) session.quit = true
      sessions.delete(ws)
    },

    error(ws, error) {
      const session = sessions.get(ws)
      if (session) session.quit = true
      sessions.delete(ws)
    },
  },
})

console.log(`[Relay] Listening on ws://localhost:${server.port}`)
console.log(`[Relay] DB: ${dbUrl}`)

// Daily prune (every 24h)
setInterval(async () => {
  try {
    const deleted = await pruneOldEvents(db, 90)
    if (deleted > 0) console.log(`[Maintenance] Pruned ${deleted} old events`)
  } catch (e) {
    console.error('[Maintenance] Prune failed:', e)
  }
}, 24 * 60 * 60 * 1000)
