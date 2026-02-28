#!/usr/bin/env node
/**
 * 2020117 Lightning Bridge
 *
 * Connects to Nostr relays, listens for Kind 21120 Wallet RPC events,
 * translates them to Lightning backend API calls, and returns responses.
 *
 * Protocol: AIP-0007
 */

import { finalizeEvent, verifyEvent, getPublicKey, nip44 } from 'nostr-tools'
import WebSocket from 'ws'
import { LightningPubAdapter } from './adapters/lightning-pub.js'
import type { LightningAdapter } from './adapters/types.js'

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BRIDGE_PRIVKEY = env('BRIDGE_PRIVKEY')
const AUTHORIZED_PUBKEYS = env('AUTHORIZED_PUBKEYS').split(',').map(s => s.trim()).filter(Boolean)
const RELAY_URLS = env('RELAY_URLS').split(',').map(s => s.trim()).filter(Boolean)
const BACKEND = env('BACKEND', 'lightning-pub')
const BACKEND_URL = env('BACKEND_URL', 'http://localhost:1776')
const LP_APP_TOKEN = env('LP_APP_TOKEN', '')

const KIND = 21120

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback
  if (v === undefined) {
    console.error(`Missing required env: ${name}`)
    process.exit(1)
  }
  return v
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

const privkeyBytes = hexToBytes(BRIDGE_PRIVKEY)
const bridgePubkey = getPublicKey(privkeyBytes)

console.log(`[bridge] pubkey: ${bridgePubkey}`)
console.log(`[bridge] authorized: ${AUTHORIZED_PUBKEYS.join(', ')}`)
console.log(`[bridge] relays: ${RELAY_URLS.join(', ')}`)
console.log(`[bridge] backend: ${BACKEND} @ ${BACKEND_URL}`)

// ---------------------------------------------------------------------------
// Backend adapter
// ---------------------------------------------------------------------------

function createAdapter(): LightningAdapter {
  switch (BACKEND) {
    case 'lightning-pub':
      if (!LP_APP_TOKEN) {
        console.error('LP_APP_TOKEN required for lightning-pub backend')
        process.exit(1)
      }
      return new LightningPubAdapter({ url: BACKEND_URL, appToken: LP_APP_TOKEN })
    default:
      console.error(`Unknown backend: ${BACKEND}`)
      process.exit(1)
  }
}

const adapter = createAdapter()

// ---------------------------------------------------------------------------
// RPC handler
// ---------------------------------------------------------------------------

type RpcRequest = {
  id: string
  method: string
  params: Record<string, unknown>
}

type RpcResponse = {
  id: string
  result?: unknown
  error?: { code: number; message: string }
}

async function handleRpc(req: RpcRequest): Promise<RpcResponse> {
  try {
    switch (req.method) {
      case 'create_user':
        return { id: req.id, result: await adapter.createUser(req.params as any) }
      case 'get_balance':
        return { id: req.id, result: await adapter.getBalance(req.params as any) }
      case 'create_invoice':
        return { id: req.id, result: await adapter.createInvoice(req.params as any) }
      case 'pay_invoice':
        return { id: req.id, result: await adapter.payInvoice(req.params as any) }
      case 'internal_transfer':
        return { id: req.id, result: await adapter.internalTransfer(req.params as any) }
      default:
        return { id: req.id, error: { code: 404, message: `Unknown method: ${req.method}` } }
    }
  } catch (e: any) {
    return { id: req.id, error: { code: 500, message: e.message || 'Internal error' } }
  }
}

// ---------------------------------------------------------------------------
// Nostr relay connection
// ---------------------------------------------------------------------------

const processedEvents = new Set<string>()

function connectRelay(url: string) {
  let ws: WebSocket
  let pingInterval: ReturnType<typeof setInterval>

  function connect() {
    console.log(`[relay] connecting to ${url}`)
    ws = new WebSocket(url)

    ws.on('open', () => {
      console.log(`[relay] connected to ${url}`)
      // Subscribe for Kind 21120 events addressed to us
      const filter = {
        kinds: [KIND],
        '#p': [bridgePubkey],
        since: Math.floor(Date.now() / 1000) - 10,
      }
      ws.send(JSON.stringify(['REQ', 'bridge', filter]))

      // Keepalive ping every 30s
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      }, 30_000)
    })

    ws.on('message', (data) => {
      handleMessage(url, ws, data.toString())
    })

    ws.on('close', () => {
      console.log(`[relay] disconnected from ${url}, reconnecting in 3s`)
      clearInterval(pingInterval)
      setTimeout(connect, 3000)
    })

    ws.on('error', (err) => {
      console.error(`[relay] error on ${url}:`, err.message)
    })
  }

  connect()
}

async function handleMessage(relayUrl: string, ws: WebSocket, raw: string) {
  try {
    const msg = JSON.parse(raw)
    if (!Array.isArray(msg)) return

    if (msg[0] === 'EVENT' && msg[2]) {
      const event = msg[2]
      await handleEvent(relayUrl, ws, event)
    }

    if (msg[0] === 'OK' && msg[2] === false) {
      console.warn(`[relay] ${relayUrl} rejected event: ${msg[3]}`)
    }
  } catch {}
}

async function handleEvent(relayUrl: string, ws: WebSocket, event: any) {
  // Deduplicate across relays
  if (processedEvents.has(event.id)) return
  processedEvents.add(event.id)
  // Garbage collect old event IDs
  if (processedEvents.size > 10000) {
    const iter = processedEvents.values()
    for (let i = 0; i < 5000; i++) {
      const v = iter.next()
      if (v.done) break
      processedEvents.delete(v.value)
    }
  }

  // 1. Check kind
  if (event.kind !== KIND) return

  // 2. Check author is authorized
  if (!AUTHORIZED_PUBKEYS.includes(event.pubkey)) {
    console.log(`[bridge] ignoring event from unauthorized pubkey: ${event.pubkey.slice(0, 16)}...`)
    return
  }

  // 3. Verify signature
  if (!verifyEvent(event)) {
    console.warn(`[bridge] invalid signature on event ${event.id}`)
    return
  }

  // 4. Decrypt content (NIP-44 v2)
  let plaintext: string
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(privkeyBytes, event.pubkey)
    plaintext = nip44.v2.decrypt(event.content, conversationKey)
  } catch (e: any) {
    console.error(`[bridge] decryption failed:`, e.message)
    return
  }

  // 5. Parse RPC request
  let rpcReq: RpcRequest
  try {
    rpcReq = JSON.parse(plaintext)
    if (!rpcReq.id || !rpcReq.method) throw new Error('missing id or method')
  } catch (e: any) {
    console.error(`[bridge] invalid RPC payload:`, e.message)
    return
  }

  console.log(`[bridge] ${rpcReq.method}(${JSON.stringify(rpcReq.params)}) id=${rpcReq.id}`)

  // 6. Execute
  const rpcRes = await handleRpc(rpcReq)

  // 7. Encrypt response
  const conversationKey = nip44.v2.utils.getConversationKey(privkeyBytes, event.pubkey)
  const encrypted = nip44.v2.encrypt(JSON.stringify(rpcRes), conversationKey)

  // 8. Sign and publish response
  const responseEvent = finalizeEvent({
    kind: KIND,
    content: encrypted,
    tags: [['p', event.pubkey], ['e', event.id]],
    created_at: Math.floor(Date.now() / 1000),
  }, privkeyBytes)

  ws.send(JSON.stringify(['EVENT', responseEvent]))
  console.log(`[bridge] → ${rpcRes.error ? 'ERROR: ' + rpcRes.error.message : 'OK'} id=${rpcReq.id}`)
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

for (const url of RELAY_URLS) {
  connectRelay(url)
}

console.log('[bridge] started')
