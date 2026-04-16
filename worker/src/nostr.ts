/**
 * Nostr primitives for sovereign mode.
 * Key management, event signing, relay connections, NIP-44/NIP-04 encryption.
 *
 * Uses @noble/curves directly for signing (proven pattern from platform nwc.ts)
 * and nostr-tools for NIP-44 (complex protocol, not worth re-implementing).
 */

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import WebSocket from 'ws'

// --- Types ---

export interface SovereignKeys {
  privkey: string    // hex, Nostr private key
  pubkey: string     // hex, Nostr public key
  nwc_uri?: string   // NWC connection string
  relays?: string[]
  lightning_address?: string
  // legacy fields (ignored, kept for .2020117_keys backward compat)
  api_key?: string
  user_id?: string
  username?: string
}

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface UnsignedEvent {
  kind: number
  tags: string[][]
  content: string
  created_at?: number
}

// --- Key Management ---

export function generateKeypair(): { privkey: string; pubkey: string } {
  const sk = randomBytes(32)
  return {
    privkey: bytesToHex(sk),
    pubkey: bytesToHex(schnorr.getPublicKey(sk)),
  }
}

export function pubkeyFromPrivkey(privkeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(privkeyHex)))
}

/** Load sovereign keys for an agent from .2020117_keys (cwd then home). */
export function loadSovereignKeys(agentName?: string): SovereignKeys | null {
  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, SovereignKeys>
      if (agentName && keys[agentName]) return keys[agentName]
      if (!agentName) {
        const first = Object.values(keys)[0]
        if (first) return first
      }
    } catch {}
  }
  return null
}

/** Returns the resolved agent name from env or first key in .2020117_keys file. */
export function loadAgentName(): string | null {
  const fromEnv = process.env.AGENT_NAME || process.env.AGENT
  if (fromEnv) return fromEnv

  for (const dir of [process.cwd(), homedir()]) {
    try {
      const raw = readFileSync(join(dir, '.2020117_keys'), 'utf-8')
      const keys = JSON.parse(raw) as Record<string, SovereignKeys>
      const firstName = Object.keys(keys)[0]
      if (firstName) return firstName
    } catch {
      // try next
    }
  }
  return null
}

/** Save sovereign keys to .2020117_keys in current directory. */
export function saveSovereignKeys(agentName: string, keys: SovereignKeys): void {
  const filePath = join(process.cwd(), '.2020117_keys')
  let existing: Record<string, SovereignKeys> = {}
  try { existing = JSON.parse(readFileSync(filePath, 'utf-8')) } catch {}
  existing[agentName] = keys
  writeFileSync(filePath, JSON.stringify(existing, null, 2))
  try { chmodSync(filePath, 0o600) } catch {}
}

// --- Event Signing ---

export function signEvent(template: UnsignedEvent, privkeyHex: string): NostrEvent {
  const sk = hexToBytes(privkeyHex)
  const pubkey = bytesToHex(schnorr.getPublicKey(sk))
  const created_at = template.created_at || Math.floor(Date.now() / 1000)

  const serialized = JSON.stringify([0, pubkey, created_at, template.kind, template.tags, template.content])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk))

  return { id, pubkey, created_at, kind: template.kind, tags: template.tags, content: template.content, sig }
}

/**
 * Sign an event with NIP-13 Proof of Work.
 * Mines a nonce tag until the event ID has `difficulty` leading zero bits.
 */
export function signEventWithPow(template: UnsignedEvent, privkeyHex: string, difficulty: number): NostrEvent {
  const sk = hexToBytes(privkeyHex)
  const pubkey = bytesToHex(schnorr.getPublicKey(sk))
  const created_at = template.created_at || Math.floor(Date.now() / 1000)
  const encoder = new TextEncoder()

  // Remove any existing nonce tag, add ours
  const baseTags = template.tags.filter(t => t[0] !== 'nonce')

  for (let nonce = 0; ; nonce++) {
    const tags = [...baseTags, ['nonce', String(nonce), String(difficulty)]]
    const serialized = JSON.stringify([0, pubkey, created_at, template.kind, tags, template.content])
    const id = bytesToHex(sha256(encoder.encode(serialized)))

    if (checkPowHex(id, difficulty)) {
      const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk))
      return { id, pubkey, created_at, kind: template.kind, tags, content: template.content, sig }
    }
  }
}

/** Check if a hex event ID has at least `difficulty` leading zero bits. */
function checkPowHex(idHex: string, difficulty: number): boolean {
  for (let i = 0; i < difficulty; i++) {
    const byteIndex = Math.floor(i / 8)
    const bitIndex = 7 - (i % 8)
    const byte = parseInt(idHex.substring(byteIndex * 2, byteIndex * 2 + 2), 16)
    if ((byte >> bitIndex) & 1) return false
  }
  return true
}

// --- NIP-44 Encryption (for NIP-XX messages) ---

let _nip44: typeof import('nostr-tools/nip44') | null = null

async function loadNip44() {
  if (!_nip44) _nip44 = await import('nostr-tools/nip44')
  return _nip44
}

export async function nip44Encrypt(privkeyHex: string, pubkeyHex: string, plaintext: string): Promise<string> {
  const nip44 = await loadNip44()
  const ck = nip44.getConversationKey(hexToBytes(privkeyHex), pubkeyHex)
  return nip44.encrypt(plaintext, ck)
}

export async function nip44Decrypt(privkeyHex: string, pubkeyHex: string, ciphertext: string): Promise<string> {
  const nip44 = await loadNip44()
  const ck = nip44.getConversationKey(hexToBytes(privkeyHex), pubkeyHex)
  return nip44.decrypt(ciphertext, ck)
}

// --- NIP-04 Encryption (for NWC/NIP-47 compatibility) ---

export async function nip04Encrypt(privkeyHex: string, pubkeyHex: string, plaintext: string): Promise<string> {
  const sharedPoint = secp256k1.getSharedSecret(hexToBytes(privkeyHex), hexToBytes('02' + pubkeyHex))
  const sharedX = sharedPoint.slice(1, 33)

  const key = await globalThis.crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['encrypt'])
  const iv = randomBytes(16)
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoded)

  return `${Buffer.from(new Uint8Array(ciphertext)).toString('base64')}?iv=${Buffer.from(iv).toString('base64')}`
}

export async function nip04Decrypt(privkeyHex: string, pubkeyHex: string, ciphertext: string): Promise<string> {
  const [ctBase64, ivParam] = ciphertext.split('?iv=')
  if (!ivParam) throw new Error('Invalid NIP-04 ciphertext')

  const sharedPoint = secp256k1.getSharedSecret(hexToBytes(privkeyHex), hexToBytes('02' + pubkeyHex))
  const sharedX = sharedPoint.slice(1, 33)

  const key = await globalThis.crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['decrypt'])
  const iv = new Uint8Array(Buffer.from(ivParam, 'base64'))
  const ct = new Uint8Array(Buffer.from(ctBase64, 'base64'))

  const plaintext = await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct)
  return new TextDecoder().decode(plaintext)
}

// --- Relay Connection ---

export interface RelaySubscription {
  id: string
  close: () => void
}

type OkCallback = { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }

export class NostrRelay {
  private ws: WebSocket | null = null
  private url: string
  private subs = new Map<string, { filters: Record<string, unknown>; handler: (event: NostrEvent) => void }>()
  private eoseCallbacks = new Map<string, () => void>()
  private pendingOk = new Map<string, OkCallback>()
  private _connected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private shouldReconnect = true

  constructor(url: string) {
    this.url = url
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url)

      const timeout = setTimeout(() => {
        reject(new Error(`Relay timeout: ${this.url}`))
      }, 10_000)

      this.ws.on('open', () => {
        clearTimeout(timeout)
        this._connected = true
        resolve()
      })

      this.ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg)
        } catch {}
      })

      this.ws.on('close', () => {
        this._connected = false
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => this.reconnect(), 5000)
        }
      })

      this.ws.on('error', (err) => {
        clearTimeout(timeout)
        if (!this._connected) reject(err)
      })
    })
  }

  private async reconnect() {
    try {
      await this.connect()
      // Re-send all active subscriptions to the relay
      for (const [id, { filters }] of this.subs) {
        this.ws!.send(JSON.stringify(['REQ', id, filters]))
      }
      if (this.subs.size > 0) {
        console.log(`[NostrRelay] Reconnected to ${this.url}, restored ${this.subs.size} subscription(s)`)
      }
    } catch (e: any) {
      console.error(`[NostrRelay] Reconnect failed for ${this.url}: ${e.message}`)
    }
  }

  private handleMessage(msg: any[]) {
    if (msg[0] === 'EVENT') {
      const sub = this.subs.get(msg[1])
      const handler = sub?.handler
      if (handler) handler(msg[2] as NostrEvent)
    } else if (msg[0] === 'OK') {
      const cb = this.pendingOk.get(msg[1])
      if (cb) {
        clearTimeout(cb.timer)
        this.pendingOk.delete(msg[1])
        cb.resolve(msg[2] as boolean)
      }
    } else if (msg[0] === 'EOSE') {
      const cb = this.eoseCallbacks.get(msg[1])
      if (cb) {
        this.eoseCallbacks.delete(msg[1])
        cb()
      }
    }
  }

  async publish(event: NostrEvent): Promise<boolean> {
    if (!this.ws || !this._connected) throw new Error('Not connected')

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingOk.delete(event.id)
        resolve(false)
      }, 10_000)

      this.pendingOk.set(event.id, { resolve, timer })
      this.ws!.send(JSON.stringify(['EVENT', event]))
    })
  }

  subscribe(
    filters: Record<string, unknown>,
    handler: (event: NostrEvent) => void,
    onEose?: () => void,
  ): RelaySubscription {
    if (!this.ws || !this._connected) throw new Error('Not connected')

    const id = randomBytes(4).toString('hex')
    this.subs.set(id, { filters, handler })
    if (onEose) this.eoseCallbacks.set(id, onEose)
    this.ws.send(JSON.stringify(['REQ', id, filters]))

    return {
      id,
      close: () => {
        this.subs.delete(id)
        this.eoseCallbacks.delete(id)

        if (this.ws && this._connected) {
          try { this.ws.send(JSON.stringify(['CLOSE', id])) } catch {}
        }
      },
    }
  }

  async close(): Promise<void> {
    this.shouldReconnect = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const [id] of this.subs) {
      if (this.ws && this._connected) {
        try { this.ws.send(JSON.stringify(['CLOSE', id])) } catch {}
      }
    }
    this.subs.clear()
    for (const [, cb] of this.pendingOk) clearTimeout(cb.timer)
    this.pendingOk.clear()
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this._connected = false
  }

  get connected(): boolean { return this._connected }
}

/** Multi-relay pool — publish to all, subscribe to all with deduplication. */
export class RelayPool {
  private relays: NostrRelay[] = []
  private urls: string[]

  constructor(urls: string[]) {
    this.urls = urls
  }

  async connect(): Promise<void> {
    const results = await Promise.allSettled(
      this.urls.map(async (url) => {
        const relay = new NostrRelay(url)
        await relay.connect()
        return relay
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled') this.relays.push(r.value)
    }
    if (this.relays.length === 0) throw new Error('Failed to connect to any relay')
  }

  async publish(event: NostrEvent): Promise<boolean> {
    const results = await Promise.allSettled(
      this.relays.map(r => r.publish(event))
    )
    return results.some(r => r.status === 'fulfilled' && r.value)
  }

  subscribe(
    filters: Record<string, unknown>,
    handler: (event: NostrEvent) => void,
    onEose?: () => void,
  ): { close: () => void } {
    const seen = new Set<string>()
    const subs: RelaySubscription[] = []
    let eoseCount = 0

    for (const relay of this.relays) {
      try {
        const sub = relay.subscribe(filters, (event) => {
          if (seen.has(event.id)) return
          seen.add(event.id)
          handler(event)
        }, onEose ? () => {
          eoseCount++
          if (eoseCount >= this.relays.length) onEose()
        } : undefined)
        subs.push(sub)
      } catch {}
    }

    return { close: () => subs.forEach(s => s.close()) }
  }

  async close(): Promise<void> {
    await Promise.all(this.relays.map(r => r.close()))
  }

  get connectedCount(): number {
    return this.relays.filter(r => r.connected).length
  }
}
