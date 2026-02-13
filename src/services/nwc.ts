import { encryptPrivkey, decryptNostrPrivkey } from './nostr'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export interface NwcParsed {
  walletPubkey: string
  relayUrl: string
  secret: string
}

// Parse NWC connection URI: nostr+walletconnect://<pubkey>?relay=<url>&secret=<hex>
export function parseNwcUri(uri: string): NwcParsed {
  if (!uri.startsWith('nostr+walletconnect://')) {
    throw new Error('Invalid NWC URI: must start with nostr+walletconnect://')
  }

  const withoutScheme = uri.slice('nostr+walletconnect://'.length)
  const questionIdx = withoutScheme.indexOf('?')
  if (questionIdx === -1) {
    throw new Error('Invalid NWC URI: missing query parameters')
  }

  const walletPubkey = withoutScheme.slice(0, questionIdx)
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error('Invalid NWC URI: wallet pubkey must be 64 hex chars')
  }

  const params = new URLSearchParams(withoutScheme.slice(questionIdx + 1))
  const relayUrl = params.get('relay')
  const secret = params.get('secret')

  if (!relayUrl) {
    throw new Error('Invalid NWC URI: missing relay parameter')
  }
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('Invalid NWC URI: missing or invalid secret parameter')
  }

  return { walletPubkey, relayUrl, secret }
}

// Encrypt NWC URI for storage (reuses nostr.ts AES-256-GCM)
export async function encryptNwcUri(uri: string, masterKey: string): Promise<{ encrypted: string; iv: string }> {
  return encryptPrivkey(uri, masterKey)
}

// Decrypt stored NWC URI
export async function decryptNwcUri(encrypted: string, iv: string, masterKey: string): Promise<string> {
  return decryptNostrPrivkey(encrypted, iv, masterKey)
}

// --- NWC Request Engine ---

// Send a NIP-47 request and wait for the response
async function nwcRequest(parsed: NwcParsed, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const { walletPubkey, relayUrl, secret } = parsed
  const secretBytes = hexToBytes(secret)
  const clientPubkey = bytesToHex(schnorr.getPublicKey(secretBytes))

  const content = JSON.stringify({ method, params })
  const encrypted = await nip04Encrypt(secret, walletPubkey, content)

  const event = {
    pubkey: clientPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 23194,
    tags: [['p', walletPubkey]],
    content: encrypted,
  }

  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretBytes))
  const signedEvent = { id, ...event, sig }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`NWC ${method} timeout (15s)`))
    }, 15000)

    const ws = new WebSocket(relayUrl)

    ws.addEventListener('open', () => {
      const subId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [23195],
        authors: [walletPubkey],
        '#e': [signedEvent.id],
        limit: 1,
      }]))
      ws.send(JSON.stringify(['EVENT', signedEvent]))
    })

    ws.addEventListener('message', async (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
        if (data[0] === 'EVENT' && data[2]?.kind === 23195) {
          clearTimeout(timeout)
          const decrypted = await nip04Decrypt(secret, walletPubkey, data[2].content)
          const result = JSON.parse(decrypted)
          ws.close()
          if (result.error) {
            reject(new Error(`NWC ${method}: ${result.error.message || result.error.code}`))
          } else {
            resolve(result.result)
          }
        }
      } catch {}
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error(`NWC WebSocket connection failed`))
    })
  })
}

// --- Public API ---

// Validate connection (get_info)
export async function validateNwcConnection(uri: string): Promise<{ supported_methods: string[] }> {
  const parsed = parseNwcUri(uri)
  const result = await nwcRequest(parsed, 'get_info')
  return { supported_methods: result?.methods || [] }
}

// Pay a BOLT-11 invoice
export async function nwcPayInvoice(parsed: NwcParsed, bolt11: string): Promise<{ preimage: string }> {
  const result = await nwcRequest(parsed, 'pay_invoice', { invoice: bolt11 })
  return { preimage: result?.preimage || '' }
}

// Get wallet balance
export async function nwcGetBalance(parsed: NwcParsed): Promise<{ balance_msats: number }> {
  const result = await nwcRequest(parsed, 'get_balance')
  return { balance_msats: result?.balance || 0 }
}

// Create an invoice (for receiving payments)
export async function nwcMakeInvoice(parsed: NwcParsed, amountMsats: number, description?: string): Promise<{ bolt11: string; payment_hash: string }> {
  const result = await nwcRequest(parsed, 'make_invoice', {
    amount: amountMsats,
    description: description || '',
  })
  return { bolt11: result?.invoice || '', payment_hash: result?.payment_hash || '' }
}

// --- Helpers: resolve Lightning Address to bolt11 ---

export async function resolveAndPayLightningAddress(
  parsed: NwcParsed,
  address: string,
  amountSats: number,
): Promise<{ preimage: string }> {
  const [user, domain] = address.split('@')
  if (!user || !domain) throw new Error(`Invalid Lightning Address: ${address}`)

  // LNURL-pay step 1: fetch metadata
  const metaResp = await fetch(`https://${domain}/.well-known/lnurlp/${user}`)
  if (!metaResp.ok) throw new Error(`LNURL fetch failed (${metaResp.status})`)

  const meta = await metaResp.json() as {
    callback: string; minSendable: number; maxSendable: number; tag: string
  }
  if (meta.tag !== 'payRequest') throw new Error(`Unexpected LNURL tag: ${meta.tag}`)

  const amountMsats = amountSats * 1000
  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    throw new Error(`Amount ${amountSats} sats out of range [${meta.minSendable / 1000}-${meta.maxSendable / 1000}]`)
  }

  // LNURL-pay step 2: get invoice
  const sep = meta.callback.includes('?') ? '&' : '?'
  const invoiceResp = await fetch(`${meta.callback}${sep}amount=${amountMsats}`)
  if (!invoiceResp.ok) throw new Error(`LNURL callback failed (${invoiceResp.status})`)

  const invoiceData = await invoiceResp.json() as { pr: string }
  if (!invoiceData.pr) throw new Error('No invoice returned from LNURL callback')

  // Step 3: pay via NWC
  return nwcPayInvoice(parsed, invoiceData.pr)
}

// --- NIP-04 Encryption ---

async function nip04Encrypt(privkeyHex: string, pubkeyHex: string, plaintext: string): Promise<string> {
  const sharedPoint = secp256k1.getSharedSecret(hexToBytes(privkeyHex), hexToBytes('02' + pubkeyHex))
  const sharedX = sharedPoint.slice(1, 33)

  const key = await crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const encoded = new TextEncoder().encode(plaintext)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, encoded)

  const ctBase64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
  const ivBase64 = btoa(String.fromCharCode(...iv))

  return `${ctBase64}?iv=${ivBase64}`
}

async function nip04Decrypt(privkeyHex: string, pubkeyHex: string, ciphertext: string): Promise<string> {
  const [ctBase64, ivParam] = ciphertext.split('?iv=')
  if (!ivParam) throw new Error('Invalid NIP-04 ciphertext')

  const sharedPoint = secp256k1.getSharedSecret(hexToBytes(privkeyHex), hexToBytes('02' + pubkeyHex))
  const sharedX = sharedPoint.slice(1, 33)

  const key = await crypto.subtle.importKey('raw', sharedX, { name: 'AES-CBC' }, false, ['decrypt'])
  const iv = Uint8Array.from(atob(ivParam), c => c.charCodeAt(0))
  const ct = Uint8Array.from(atob(ctBase64), c => c.charCodeAt(0))

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ct)
  return new TextDecoder().decode(plaintext)
}
