import type { NostrEvent, NostrFilter, Env } from './types'
import { isEphemeral, isDvmKind, isDvmRequestKind, isAllowedKind, checkPow } from './types'
import { verifyEvent } from './crypto'
import { saveEvent, queryEvents, isAllowedPubkey, hasZappedRelay } from './db'

interface Session {
  subscriptions: Map<string, NostrFilter[]>
  quit: boolean
}

/**
 * Durable Object for managing WebSocket connections.
 * Uses Hibernation API to reduce costs when idle.
 */
export class RelayDO implements DurableObject {
  private sessions = new Map<WebSocket, Session>()
  private env: Env

  constructor(private state: DurableObjectState, env: Env) {
    this.env = env
    // Restore hibernated sessions
    for (const ws of this.state.getWebSockets()) {
      this.sessions.set(ws, { subscriptions: new Map(), quit: false })
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    this.state.acceptWebSocket(server)
    this.sessions.set(server, { subscriptions: new Map(), quit: false })

    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const session = this.sessions.get(ws)
    if (!session || session.quit) return

    try {
      const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))
      if (!Array.isArray(msg) || msg.length < 2) return

      const type = msg[0]

      if (type === 'EVENT') {
        await this.handleEvent(ws, msg[1] as NostrEvent)
      } else if (type === 'REQ') {
        const subId = msg[1] as string
        const filters = msg.slice(2) as NostrFilter[]
        await this.handleReq(ws, session, subId, filters)
      } else if (type === 'CLOSE') {
        const subId = msg[1] as string
        session.subscriptions.delete(subId)
      }
    } catch (e) {
      this.sendNotice(ws, `Error: ${e instanceof Error ? e.message : 'unknown'}`)
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws)
    if (session) session.quit = true
    this.sessions.delete(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const session = this.sessions.get(ws)
    if (session) session.quit = true
    this.sessions.delete(ws)
  }

  // --- Handlers ---

  private async handleEvent(ws: WebSocket, event: NostrEvent): Promise<void> {
    // Validate structure
    if (!event.id || !event.pubkey || !event.sig || event.kind === undefined) {
      this.sendOk(ws, event.id || '', false, 'invalid: missing required fields')
      return
    }

    // 1. Kind whitelist
    if (!isAllowedKind(event.kind)) {
      this.sendOk(ws, event.id, false, `blocked: kind ${event.kind} not allowed`)
      return
    }

    // 2. Verify signature
    if (!verifyEvent(event)) {
      this.sendOk(ws, event.id, false, 'invalid: bad signature')
      return
    }

    // 3. Reject events too far in the future (10 min)
    const now = Math.floor(Date.now() / 1000)
    if (event.created_at > now + 600) {
      this.sendOk(ws, event.id, false, 'invalid: created_at too far in future')
      return
    }

    // 4. Registered users bypass POW/Zap checks
    const isRegistered = await isAllowedPubkey(this.env.APP_DB, event.pubkey)
    if (!isRegistered) {
      // 5. DVM result/feedback kinds (6xxx/7000) — open to external providers
      const isDvmResult = isDvmKind(event.kind)
      // 6. Zap receipt (9735) — must be writable for zap verification to work
      const isZapReceipt = event.kind === 9735

      if (!isDvmResult && !isZapReceipt) {
        // 7. POW check for external users
        const minPow = parseInt(this.env.MIN_POW || '20', 10)
        if (!checkPow(event.id, minPow)) {
          this.sendOk(ws, event.id, false, `pow: required difficulty ${minPow}`)
          return
        }

        // 8. DVM request kinds (5xxx) require zap verification
        if (isDvmRequestKind(event.kind)) {
          const relayPubkey = this.env.RELAY_PUBKEY
          if (relayPubkey) {
            const zapped = await hasZappedRelay(this.env.DB, event.pubkey, relayPubkey)
            if (!zapped) {
              const addr = this.env.RELAY_LIGHTNING_ADDRESS || ''
              this.sendOk(ws, event.id, false, `blocked: zap ${addr} (21 sats) before submitting DVM requests`)
              return
            }
          }
        }
      }
    }

    // 9. Passed all checks — store and broadcast

    // Ephemeral events: broadcast but don't store
    if (isEphemeral(event.kind)) {
      this.broadcast(event)
      this.sendOk(ws, event.id, true)
      return
    }

    // Save to D1
    const saved = await saveEvent(this.env.DB, event)
    if (!saved) {
      this.sendOk(ws, event.id, true, 'duplicate: already have this event')
      return
    }

    this.sendOk(ws, event.id, true)

    // Broadcast to all connected clients with matching subscriptions
    this.broadcast(event)

    // Webhook to app for interesting event kinds
    if (this.env.APP_WEBHOOK_URL) {
      const interestingKinds = [1, 3, 5, 7, 1112, 34550, 4550, 7000]
      const isDvm = event.kind >= 6000 && event.kind <= 6999
      if (interestingKinds.includes(event.kind) || isDvm) {
        this.state.waitUntil(this.notifyApp(event))
      }
    }
  }

  private async handleReq(ws: WebSocket, session: Session, subId: string, filters: NostrFilter[]): Promise<void> {
    // Limit subscriptions per connection
    if (session.subscriptions.size >= 20) {
      this.sendNotice(ws, 'Too many subscriptions')
      return
    }

    // Limit filters per subscription
    if (filters.length > 10) {
      this.sendNotice(ws, 'Too many filters')
      return
    }

    session.subscriptions.set(subId, filters)

    // Query stored events and send them
    for (const filter of filters) {
      try {
        const events = await queryEvents(this.env.DB, filter)
        for (const event of events) {
          this.send(ws, ['EVENT', subId, event])
        }
      } catch (e) {
        console.error(`[REQ] Query error:`, e)
      }
    }

    // End of stored events
    this.send(ws, ['EOSE', subId])
  }

  // --- Broadcasting ---

  private broadcast(event: NostrEvent): void {
    for (const [ws, session] of this.sessions) {
      if (session.quit) continue
      for (const [subId, filters] of session.subscriptions) {
        if (this.matchesAnyFilter(event, filters)) {
          this.send(ws, ['EVENT', subId, event])
          break // Only send once per subscription
        }
      }
    }
  }

  private matchesAnyFilter(event: NostrEvent, filters: NostrFilter[]): boolean {
    return filters.some(f => this.matchesFilter(event, f))
  }

  private matchesFilter(event: NostrEvent, filter: NostrFilter): boolean {
    if (filter.ids && !filter.ids.includes(event.id)) return false
    if (filter.authors && !filter.authors.includes(event.pubkey)) return false
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false
    if (filter.since && event.created_at < filter.since) return false
    if (filter.until && event.created_at > filter.until) return false

    // Check tag filters
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

  // --- Helpers ---

  private send(ws: WebSocket, msg: any): void {
    try { ws.send(JSON.stringify(msg)) } catch {}
  }

  private sendOk(ws: WebSocket, eventId: string, ok: boolean, message?: string): void {
    this.send(ws, ['OK', eventId, ok, message || ''])
  }

  private sendNotice(ws: WebSocket, message: string): void {
    this.send(ws, ['NOTICE', message])
  }

  private async notifyApp(event: NostrEvent): Promise<void> {
    try {
      const url = this.env.APP_WEBHOOK_URL!
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.env.APP_WEBHOOK_SECRET) {
        headers['X-Relay-Secret'] = this.env.APP_WEBHOOK_SECRET
      }
      await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      })
    } catch (e) {
      console.error('[Webhook] Failed to notify app:', e)
    }
  }
}
