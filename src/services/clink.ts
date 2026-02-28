/**
 * Server-side CLINK debit service — replaces NWC for DVM job payments.
 *
 * Uses @shocknet/clink-sdk to send debit requests to customer wallets
 * via Nostr relay (Kind 21002, NIP-44 encrypted).
 *
 * The platform generates an invoice from the provider's Lightning Address
 * (LNURL-pay), then debits the customer's wallet via their ndebit authorization.
 */

import { decodeBech32, newNdebitPaymentRequest, getPublicKey } from '@shocknet/clink-sdk'
import { nip44, finalizeEvent } from 'nostr-tools'
import { encryptPrivkey, decryptNostrPrivkey } from './nostr'

// --- Platform CLINK identity (deterministic, derived from NOSTR_MASTER_KEY) ---

const platformKeyCache = new Map<string, Uint8Array>()

function getPlatformKey(masterKey: string): Uint8Array {
  let key = platformKeyCache.get(masterKey)
  if (!key) {
    // Derive a deterministic 32-byte private key from master key + fixed salt
    const seed = masterKey + ':clink-platform-identity'
    const bytes = new Uint8Array(32)
    // Simple deterministic derivation: SHA-256 of seed string
    const encoder = new TextEncoder()
    const seedBytes = encoder.encode(seed)
    // Use first 32 bytes of hex master key as the private key base,
    // XOR with hash of salt for domain separation
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(masterKey.slice(i * 2, i * 2 + 2), 16) ^ seedBytes[i % seedBytes.length]
    }
    key = bytes
    platformKeyCache.set(masterKey, key)
  }
  return key
}

export function getPlatformPubkey(masterKey: string): string {
  return getPublicKey(getPlatformKey(masterKey))
}

// --- Encrypt/decrypt ndebit for storage ---

export async function encryptNdebit(ndebit: string, masterKey: string): Promise<{ encrypted: string; iv: string }> {
  return encryptPrivkey(ndebit, masterKey)
}

export async function decryptNdebit(encrypted: string, iv: string, masterKey: string): Promise<string> {
  return decryptNostrPrivkey(encrypted, iv, masterKey)
}

// --- Validate ndebit string ---

export function validateNdebit(ndebit: string): { valid: boolean; error?: string } {
  try {
    const decoded = decodeBech32(ndebit)
    if (decoded.type !== 'ndebit') {
      return { valid: false, error: `Not an ndebit string (got: ${decoded.type})` }
    }
    return { valid: true }
  } catch (e: any) {
    return { valid: false, error: e.message }
  }
}

// --- Debit customer wallet ---

export interface ServerDebitResult {
  ok: boolean
  preimage?: string
  error?: string
}

/**
 * Generate a Lightning invoice from a Lightning Address via LNURL-pay,
 * then debit the customer's wallet via CLINK.
 *
 * Uses raw WebSocket to communicate with the Nostr relay instead of
 * nostr-tools SimplePool, for compatibility with Cloudflare Workers.
 */
export async function debitForPayment(opts: {
  ndebit: string              // customer's decrypted ndebit1... authorization
  lightningAddress: string    // recipient's Lightning Address (provider or platform)
  amountSats: number
  masterKey: string           // NOSTR_MASTER_KEY for deterministic platform identity
  timeoutSeconds?: number
}): Promise<ServerDebitResult> {
  const { ndebit, lightningAddress, amountSats, masterKey, timeoutSeconds = 30 } = opts

  // Step 1: Generate invoice from recipient's Lightning Address
  const bolt11 = await resolveInvoice(lightningAddress, amountSats)

  // Step 2: Send debit request to customer's wallet via raw WebSocket
  const decoded = decodeBech32(ndebit)
  if (decoded.type !== 'ndebit') {
    return { ok: false, error: `Invalid ndebit (type: ${decoded.type})` }
  }

  const privateKey = getPlatformKey(masterKey)
  const publicKey = getPublicKey(privateKey)
  const toPub = decoded.data.pubkey
  const relayUrl = decoded.data.relay

  // Build Kind 21002 event
  const data = newNdebitPaymentRequest(bolt11, undefined, decoded.data.pointer)
  const content = nip44.encrypt(JSON.stringify(data), nip44.getConversationKey(privateKey, toPub))
  const unsigned = {
    content,
    created_at: Math.floor(Date.now() / 1000),
    kind: 21002,
    pubkey: publicKey,
    tags: [['p', toPub], ['clink_version', '1']],
  }
  const signed = finalizeEvent(unsigned, privateKey)
  const subId = 'clink_' + signed.id.slice(0, 8)

  // Step 3: Connect to relay, subscribe, publish, wait for response
  return new Promise<ServerDebitResult>((resolve, reject) => {
    let resolved = false
    const done = (result: ServerDebitResult) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      resolve(result)
    }
    const fail = (error: string) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      try { ws.close() } catch {}
      reject(new Error(error))
    }

    const timer = setTimeout(() => fail('CLINK response timeout'), timeoutSeconds * 1000)

    const ws = new WebSocket(relayUrl)
    ws.addEventListener('open', () => {
      // Subscribe for response BEFORE publishing
      const filter = {
        since: Math.floor(Date.now() / 1000) - 5,
        kinds: [21002],
        '#p': [publicKey],
        '#e': [signed.id],
      }
      ws.send(JSON.stringify(['REQ', subId, filter]))
      // Publish the debit request
      ws.send(JSON.stringify(['EVENT', signed]))
    })

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer))
        // Handle OK response (publish acknowledgment) — just log
        if (msg[0] === 'OK') {
          const success = msg[2]
          if (!success) console.warn('[CLINK] Relay rejected event:', msg[3])
          return
        }
        // Handle EVENT response (the debit response from Lightning.Pub)
        if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]?.kind === 21002) {
          const event = msg[2]
          try {
            const decrypted = nip44.decrypt(event.content, nip44.getConversationKey(privateKey, toPub))
            const result = JSON.parse(decrypted)
            if (result.res === 'ok') {
              done({ ok: true, preimage: result.preimage })
            } else {
              done({ ok: false, error: result.error || 'Debit rejected' })
            }
          } catch {
            fail('Failed to decrypt CLINK response')
          }
        }
      } catch {
        // Ignore unparseable messages
      }
    })

    ws.addEventListener('error', () => fail('WebSocket connection error'))
    ws.addEventListener('close', () => {
      if (!resolved) fail('WebSocket closed before response')
    })
  })
}

// --- LNURL-pay invoice generation ---

async function resolveInvoice(lightningAddress: string, amountSats: number): Promise<string> {
  const [user, domain] = lightningAddress.split('@')
  if (!user || !domain) throw new Error(`Invalid Lightning Address: ${lightningAddress}`)

  const metaResp = await fetch(`https://${domain}/.well-known/lnurlp/${user}`)
  if (!metaResp.ok) throw new Error(`LNURL fetch failed: ${metaResp.status}`)

  const meta = await metaResp.json() as {
    callback: string; minSendable: number; maxSendable: number; tag: string
  }
  if (meta.tag !== 'payRequest') throw new Error(`Not a LNURL-pay endpoint (tag: ${meta.tag})`)

  const amountMsats = amountSats * 1000
  if (amountMsats < meta.minSendable) throw new Error(`Amount ${amountSats} below min ${meta.minSendable / 1000}`)
  if (amountMsats > meta.maxSendable) throw new Error(`Amount ${amountSats} above max ${meta.maxSendable / 1000}`)

  const sep = meta.callback.includes('?') ? '&' : '?'
  const invoiceResp = await fetch(`${meta.callback}${sep}amount=${amountMsats}`)
  if (!invoiceResp.ok) throw new Error(`Invoice request failed: ${invoiceResp.status}`)

  const data = await invoiceResp.json() as { pr?: string; reason?: string }
  if (!data.pr) throw new Error(`No invoice returned: ${data.reason || 'unknown'}`)

  return data.pr
}
