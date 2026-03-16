#!/usr/bin/env node
/**
 * Nostr-native Ollama DVM Worker — pay-to-pipe Hyperswarm proxy
 *
 * Protocol:
 *   1. JSON handshake over Hyperswarm (newline-delimited):
 *        → skill_request
 *        ← skill_response
 *        → session_start  { budget, ... }
 *        ← offer          { invoice, amount_sats }   (if sats > 0)
 *        [customer pays invoice]
 *        ← accepted
 *   2. After accepted: remaining bytes are piped directly to Ollama HTTP.
 *      Customer sends standard Ollama API requests (POST /api/generate etc.)
 *
 * Usage:
 *   node ollama_worker.js [options]
 *
 * Options:
 *   --agent <name>    Agent name from .2020117_keys (default: first)
 *   --model <model>   Ollama model (default: qwen3.5:9b)
 *   --kinds <k,...>   DVM job kinds (default: 5100,5302,5303)
 *   --ollama <url>    Ollama base URL (default: http://localhost:11434)
 *   --sats <n>        Sats per session (default: 1, 0 = free)
 */

import { WebSocket } from 'ws'
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket

import { finalizeEvent, getPublicKey, nip04 } from 'nostr-tools'
import { minePow } from 'nostr-tools/nip13'
import { Relay } from 'nostr-tools/relay'
import Hyperswarm from 'hyperswarm'
import { createHash, randomBytes } from 'crypto'
import { createConnection } from 'net'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i !== -1 ? args[i + 1] : fallback }
const AGENT_NAME   = getArg('agent', null)
const MODEL        = getArg('model', process.env.OLLAMA_MODEL || 'qwen3.5:9b')
const OLLAMA_URL   = getArg('ollama', 'http://localhost:11434')
const KINDS        = getArg('kinds', '5100,5302,5303').split(',').map(Number)
const SATS_PER_SESSION = Number(getArg('sats', '1'))
const [OLLAMA_HOST, OLLAMA_PORT] = (() => { const u = new URL(OLLAMA_URL); return [u.hostname, Number(u.port) || 11434] })()

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)

// ── Load config ───────────────────────────────────────────────────────────────
function loadConfig(agentName) {
  const candidates = [join(process.cwd(), '.2020117_keys'), join(homedir(), '.2020117_keys')]
  let keysData = null
  for (const p of candidates) { if (existsSync(p)) { keysData = JSON.parse(readFileSync(p, 'utf8')); break } }
  if (!keysData) throw new Error('No .2020117_keys file found')
  const agents = Object.keys(keysData)
  const name = agentName || agents[0]
  const cfg = keysData[name]
  if (!cfg) throw new Error(`Agent "${name}" not found. Available: ${agents.join(', ')}`)
  return { name, ...cfg }
}

// ── NWC client (NIP-47) ───────────────────────────────────────────────────────
function parseNWC(uri) {
  const s = uri.replace('nostr+walletconnect://', '')
  const q = s.indexOf('?')
  const walletPubkey = q === -1 ? s : s.slice(0, q)
  const params = new URLSearchParams(q === -1 ? '' : s.slice(q + 1))
  return { walletPubkey, relay: params.get('relay'), secret: params.get('secret') }
}

class NWCClient {
  constructor(uri) {
    const { walletPubkey, relay, secret } = parseNWC(uri)
    this.walletPubkey = walletPubkey
    this.relayUrl = relay
    this.secret = secret
    this.privkey = Uint8Array.from(Buffer.from(secret, 'hex'))
    this.pubkey = getPublicKey(this.privkey)
    this.conn = null
    this.pending = new Map()
    this.paymentListeners = new Map()
  }

  async ensureConnected() {
    if (this.conn?.connected) return
    this.conn = await Relay.connect(this.relayUrl)
    this.conn.subscribe([{ kinds: [23195], '#p': [this.pubkey] }, { kinds: [23196], '#p': [this.pubkey] }], {
      onevent: async (event) => {
        try {
          const plain = await nip04.decrypt(this.secret, this.walletPubkey, event.content)
          const data = JSON.parse(plain)
          if (event.kind === 23195) {
            const eTag = event.tags.find(t => t[0] === 'e')
            if (eTag) { const p = this.pending.get(eTag[1]); if (p) { this.pending.delete(eTag[1]); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result) } }
          } else if (event.kind === 23196) {
            const n = data.notification
            if (n?.type === 'payment_received' && n.payment_hash) {
              const l = this.paymentListeners.get(n.payment_hash)
              if (l) { this.paymentListeners.delete(n.payment_hash); l(n) }
            }
          }
        } catch {}
      }
    })
    log('NWC:      connected to ' + this.relayUrl)
  }

  async request(method, params = {}, timeoutMs = 30_000) {
    await this.ensureConnected()
    const encrypted = await nip04.encrypt(this.secret, this.walletPubkey, JSON.stringify({ method, params }))
    const event = finalizeEvent({ kind: 23194, created_at: Math.floor(Date.now() / 1000), tags: [['p', this.walletPubkey]], content: encrypted }, this.privkey)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(event.id); reject(new Error(`NWC timeout: ${method}`)) }, timeoutMs)
      this.pending.set(event.id, { resolve: v => { clearTimeout(timer); resolve(v) }, reject: e => { clearTimeout(timer); reject(e) } })
      this.conn.publish(event).catch(reject)
    })
  }

  async makeInvoice(amountSats, description = 'Ollama session') {
    const result = await this.request('make_invoice', { amount: amountSats * 1000, description })
    return { invoice: result.invoice, paymentHash: result.payment_hash }
  }

  waitForPayment(paymentHash, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
      const fail   = e => { if (!done) { done = true; clearTimeout(timer); reject(e) } }
      this.paymentListeners.set(paymentHash, n => { this.paymentListeners.delete(paymentHash); finish(n) })
      const poll = async () => {
        while (!done) {
          await new Promise(r => setTimeout(r, 3000))
          if (done) break
          try { const r = await this.request('lookup_invoice', { payment_hash: paymentHash }, 8_000); if (r?.settled_at || r?.preimage) { finish(r); break } } catch {}
        }
      }
      poll().catch(() => {})
      const timer = setTimeout(() => { this.paymentListeners.delete(paymentHash); fail(new Error('Payment timeout')) }, timeoutMs)
    })
  }
}

// ── Nostr helpers ─────────────────────────────────────────────────────────────
function sign(privkeyHex, kind, content, tags = []) {
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  return finalizeEvent({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) }, privkey)
}
function signWithPow(privkeyHex, kind, content, tags = [], difficulty = 20) {
  const privkey = Uint8Array.from(Buffer.from(privkeyHex, 'hex'))
  return finalizeEvent(minePow({ kind, content, tags, created_at: Math.floor(Date.now() / 1000) }, difficulty), privkey)
}
function topicFromKind(kind) { return createHash('sha256').update(`2020117-dvm-kind-${kind}`).digest() }

// ── Inject think:false into Ollama requests ───────────────────────────────────
function injectThinkFalse(rawBytes) {
  const raw = rawBytes.toString()
  const sep = raw.indexOf('\r\n\r\n')
  if (sep === -1) return rawBytes
  const header = raw.slice(0, sep + 4)
  const body = raw.slice(sep + 4)
  if (!header.includes('POST') || (!header.includes('/api/generate') && !header.includes('/api/chat'))) return rawBytes
  try {
    const json = JSON.parse(body)
    if (json.think !== undefined) return rawBytes
    json.think = false
    const newBody = JSON.stringify(json)
    const newHeader = header.replace(/Content-Length:\s*\d+/i, `Content-Length: ${Buffer.byteLength(newBody)}`)
    return Buffer.from(newHeader + newBody)
  } catch { return rawBytes }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig(AGENT_NAME)
  const { name, privkey, lightning_address, nwc_uri, relays: cfgRelays } = cfg
  const pubkey = getPublicKey(Uint8Array.from(Buffer.from(privkey, 'hex')))

  log(`=== Ollama DVM Worker (pay-to-pipe) ===`)
  log(`Agent:    ${name}`)
  log(`Pubkey:   ${pubkey}`)
  log(`Model:    ${MODEL}`)
  log(`Kinds:    ${KINDS.join(', ')}`)
  log(`Mode:     ${SATS_PER_SESSION > 0 ? `${SATS_PER_SESSION} sats/session` : 'free'}`)

  await fetch(`${OLLAMA_URL}/api/tags`).catch(() => { throw new Error(`Ollama not reachable at ${OLLAMA_URL}`) })
  log(`Ollama:   OK`)

  // NWC
  let nwc = null
  if (nwc_uri && SATS_PER_SESSION > 0) {
    try { nwc = new NWCClient(nwc_uri); await nwc.ensureConnected() }
    catch (e) { log(`NWC:      failed (${e.message}) — sessions will be free`); nwc = null }
  }

  // Nostr relays
  const relayUrls = cfgRelays?.length ? cfgRelays : ['wss://relay.2020117.xyz']
  const relays = []
  for (const url of relayUrls) {
    try { relays.push(await Relay.connect(url)); log(`Relay:    connected ${url}`) }
    catch { log(`Relay:    FAILED ${url}`) }
  }
  if (!relays.length) throw new Error('No Nostr relays connected')

  async function ensureRelay(i) {
    if (relays[i]?.connected) return relays[i]
    try { relays[i] = await Relay.connect(relayUrls[i]); return relays[i] } catch { return null }
  }
  const publish = event => Promise.all(relays.map(async (_, i) => {
    const r = await ensureRelay(i); if (!r) return
    try { return r.publish(event).catch(e => log(`Publish error: ${e.message}`)) } catch (e) { log(`Publish error: ${e.message}`) }
  }))

  log('Mining POW for Kind 0...')
  await publish(signWithPow(privkey, 0, JSON.stringify({ name, about: `Ollama proxy · ${MODEL}`, ...(lightning_address && { lud16: lightning_address }) }), [], 20))
  log('Published: Kind 0 profile')

  for (const kind of KINDS) {
    await publish(sign(privkey, 31990, JSON.stringify({ name, about: `kind ${kind} / ${MODEL}` }), [
      ['d', `${name}-${kind}`], ['k', String(kind)], ['model', MODEL],
      ...(lightning_address ? [['lud16', lightning_address]] : []),
    ]))
  }
  log('Published: Kind 31990 handler info')

  const publishHeartbeat = () =>
    publish(sign(privkey, 30333, '', [
      ['d', pubkey], ['status', 'online'], ['capacity', '10'],
      ['kinds', KINDS.map(String).join(',')],
      ['price', KINDS.map(k => `${k}:${SATS_PER_SESSION}`).join(',')], // per-session flat fee (not per-job or per-minute)
    ])).then(() => log('Heartbeat'))

  await publishHeartbeat()
  setInterval(publishHeartbeat, 60_000)

  // ── Hyperswarm ───────────────────────────────────────────────────────────
  const swarm = new Hyperswarm()
  let connections = 0

  swarm.on('connection', (socket) => {
    socket.setKeepAlive(true)
    socket.setTimeout(0)
    connections++
    const id = socket.remotePublicKey?.toString('hex').slice(0, 8) ?? '????????'
    log(`P2P [${id}] connected (total: ${connections})`)

    // ── JSON handshake phase ─────────────────────────────────────────────
    let lineBuf = ''
    let handshakeDone = false
    let pendingBytes = [] // bytes received after handshake is done (before pipe setup)

    const sendJSON = obj => socket.write(JSON.stringify(obj) + '\n')

    const startProxy = (firstBytes) => {
      handshakeDone = true
      const ollama = createConnection(OLLAMA_PORT, OLLAMA_HOST)
      ollama.setKeepAlive(true)
      ollama.setTimeout(0)

      // Flush buffered bytes (first HTTP request)
      const allPending = Buffer.concat([firstBytes, ...pendingBytes])
      if (allPending.length) ollama.write(injectThinkFalse(allPending))
      pendingBytes = []

      // Pipe remaining
      socket.on('data', chunk => ollama.write(injectThinkFalse(chunk)))
      ollama.pipe(socket)

      let cleaned = false
      const cleanup = () => {
        if (cleaned) return; cleaned = true
        connections--
        log(`P2P [${id}] disconnected (total: ${connections})`)
        socket.destroy(); ollama.destroy()
      }
      socket.on('close', cleanup); socket.on('error', cleanup)
      ollama.on('close', cleanup); ollama.on('error', e => { log(`P2P [${id}] Ollama: ${e.message}`); cleanup() })
    }

    const handleMessage = async (msg) => {
      if (msg.type === 'skill_request') {
        sendJSON({ type: 'skill_response', skill: { kinds: KINDS, model: MODEL, price_sats: SATS_PER_SESSION } })
        return
      }

      if (msg.type === 'session_start') {
        log(`P2P [${id}] session_start budget=${msg.budget}`)
        if (SATS_PER_SESSION <= 0 || !nwc) {
          sendJSON({ type: 'accepted', session_id: msg.session_id })
          startProxy(Buffer.alloc(0))
          return
        }
        try {
          const { invoice, paymentHash } = await nwc.makeInvoice(SATS_PER_SESSION, `Ollama session ${id}`)
          sendJSON({ type: 'offer', invoice, amount_sats: SATS_PER_SESSION })
          log(`P2P [${id}] waiting for payment...`)
          await nwc.waitForPayment(paymentHash)
          log(`P2P [${id}] payment confirmed — opening proxy`)
          sendJSON({ type: 'accepted', session_id: msg.session_id })
          startProxy(Buffer.alloc(0))
        } catch (e) {
          log(`P2P [${id}] payment failed: ${e.message}`)
          sendJSON({ type: 'error', message: `Payment failed: ${e.message}` })
          socket.destroy()
        }
        return
      }

      if (msg.type === 'ping') { sendJSON({ type: 'pong' }); return }
      if (msg.type === 'accept') return // ignore, we use lookup_invoice polling
    }

    socket.on('data', (chunk) => {
      if (handshakeDone) { pendingBytes.push(chunk); return }

      lineBuf += chunk.toString()
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        // Check if this looks like HTTP (not JSON handshake) → skip straight to proxy
        if (line.startsWith('GET ') || line.startsWith('POST ') || line.startsWith('PUT ') || line.startsWith('DELETE ')) {
          if (SATS_PER_SESSION > 0) {
            log(`P2P [${id}] direct HTTP without handshake — rejected`)
            sendJSON({ type: 'error', message: 'Handshake required' })
            socket.destroy()
            return
          }
          log(`P2P [${id}] direct HTTP (no handshake) — free pass`)
          startProxy(Buffer.from(line + '\n' + lineBuf))
          lineBuf = ''
          return
        }
        try { handleMessage(JSON.parse(line)) } catch { /* bad JSON */ }
      }
    })

    socket.on('close', () => { if (!handshakeDone) { connections--; log(`P2P [${id}] disconnected during handshake`) } })
    socket.on('error', () => { if (!handshakeDone) connections-- })
  })

  for (const kind of KINDS) {
    await swarm.join(topicFromKind(kind), { server: true, client: false }).flushed()
    log(`Swarm:    listening on kind ${kind}`)
  }

  log(`Ready. ${SATS_PER_SESSION > 0 ? `Charging ${SATS_PER_SESSION} sats/session` : 'Free mode'}`)

  process.on('SIGINT',  async () => { await swarm.destroy(); process.exit(0) })
  process.on('SIGTERM', async () => { await swarm.destroy(); process.exit(0) })
}

process.on('unhandledRejection', err => log(`Unhandled: ${err?.message ?? err}`))
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
