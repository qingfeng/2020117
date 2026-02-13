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

// Validate NWC connection by sending get_info request
export async function validateNwcConnection(uri: string): Promise<{ supported_methods: string[] }> {
  const { walletPubkey, relayUrl, secret } = parseNwcUri(uri)

  // Derive client pubkey from secret
  const secretBytes = hexToBytes(secret)
  const clientPubkey = bytesToHex(schnorr.getPublicKey(secretBytes))

  // Build NIP-47 get_info request (Kind 23194)
  const content = JSON.stringify({ method: 'get_info' })

  // Encrypt content using NIP-04 (simplified: AES-256-CBC with shared secret)
  const encrypted = await nip04Encrypt(secret, walletPubkey, content)

  const event = {
    pubkey: clientPubkey,
    created_at: Math.floor(Date.now() / 1000),
    kind: 23194,
    tags: [['p', walletPubkey]],
    content: encrypted,
  }

  // Compute event ID
  const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))

  // Sign
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretBytes))
  const signedEvent = { id, ...event, sig }

  // Connect to relay and send request
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error('NWC validation timeout (10s)'))
    }, 10000)

    const ws = new WebSocket(relayUrl)

    ws.addEventListener('open', () => {
      // Subscribe to response events
      const subId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [23195],
        authors: [walletPubkey],
        '#e': [signedEvent.id],
        limit: 1,
      }]))
      // Send the request event
      ws.send(JSON.stringify(['EVENT', signedEvent]))
    })

    ws.addEventListener('message', async (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
        if (data[0] === 'EVENT' && data[2]?.kind === 23195) {
          clearTimeout(timeout)
          // Decrypt response
          const decrypted = await nip04Decrypt(secret, walletPubkey, data[2].content)
          const result = JSON.parse(decrypted)
          ws.close()
          if (result.error) {
            reject(new Error(`NWC error: ${result.error.message || result.error.code}`))
          } else {
            resolve({ supported_methods: result.result?.methods || [] })
          }
        }
      } catch {}
    })

    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('NWC WebSocket connection failed'))
    })
  })
}

// NIP-04 encrypt (AES-256-CBC with shared point)
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

// NIP-04 decrypt
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
