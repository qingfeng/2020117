import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { bech32 } from 'bech32'

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

// --- Key Generation & Encryption ---

export async function generateNostrKeypair(masterKeyHex: string): Promise<{
  pubkey: string
  privEncrypted: string
  iv: string
}> {
  const privateKey = schnorr.utils.randomSecretKey()
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))

  const { encrypted, iv } = await encryptPrivkey(bytesToHex(privateKey), masterKeyHex)

  return { pubkey, privEncrypted: encrypted, iv }
}

async function importMasterKey(masterKeyHex: string): Promise<CryptoKey> {
  const keyBytes = hexToBytes(masterKeyHex)
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptPrivkey(privkeyHex: string, masterKeyHex: string): Promise<{ encrypted: string; iv: string }> {
  const key = await importMasterKey(masterKeyHex)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoded = new TextEncoder().encode(privkeyHex)

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded)

  return {
    encrypted: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv.buffer),
  }
}

export async function decryptNostrPrivkey(encrypted: string, iv: string, masterKeyHex: string): Promise<string> {
  const key = await importMasterKey(masterKeyHex)
  const ciphertextBuf = base64ToBuffer(encrypted)
  const ivBuf = new Uint8Array(base64ToBuffer(iv))

  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivBuf }, key, ciphertextBuf)

  return new TextDecoder().decode(plaintext)
}

// --- Event Building & Signing ---

export async function buildSignedEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kind: number
  content: string
  tags: string[][]
  createdAt?: number
}): Promise<NostrEvent> {
  const privkeyHex = await decryptNostrPrivkey(params.privEncrypted, params.iv, params.masterKey)
  const privateKey = hexToBytes(privkeyHex)
  const pubkey = bytesToHex(schnorr.getPublicKey(privateKey))

  const event = {
    pubkey,
    created_at: params.createdAt || Math.floor(Date.now() / 1000),
    kind: params.kind,
    tags: params.tags,
    content: params.content,
  }

  // Compute event ID: sha256 of [0, pubkey, created_at, kind, tags, content]
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))

  // Schnorr sign
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privateKey))

  return { id, ...event, sig }
}

// --- NIP-19 Encoding ---

export function pubkeyToNpub(hex: string): string {
  const bytes = hexToBytes(hex)
  const words = bech32.toWords(Array.from(bytes))
  return bech32.encode('npub', words, 90)
}

export function npubToPubkey(npub: string): string | null {
  try {
    const { prefix, words } = bech32.decode(npub, 90)
    if (prefix !== 'npub') return null
    const bytes = bech32.fromWords(words)
    return bytesToHex(new Uint8Array(bytes))
  } catch {
    return null
  }
}

export function privkeyToNsec(hex: string): string {
  const bytes = hexToBytes(hex)
  const words = bech32.toWords(Array.from(bytes))
  return bech32.encode('nsec', words, 90)
}

export function nsecToPrivkey(nsec: string): string | null {
  try {
    const { prefix, words } = bech32.decode(nsec, 90)
    if (prefix !== 'nsec') return null
    return bytesToHex(new Uint8Array(bech32.fromWords(words)))
  } catch {
    return null
  }
}

// --- NIP-13 PoW Verification ---

export function countLeadingZeroBits(hex: string): number {
  let count = 0
  for (const ch of hex) {
    const nibble = parseInt(ch, 16)
    if (nibble === 0) {
      count += 4
    } else {
      // Count leading zero bits in this nibble
      if (nibble < 2) count += 3
      else if (nibble < 4) count += 2
      else if (nibble < 8) count += 1
      break
    }
  }
  return count
}

// --- Event Verification ---

export function verifyEvent(event: NostrEvent): boolean {
  try {
    // Recompute event ID
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ])
    const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)))
    if (expectedId !== event.id) return false

    // Verify Schnorr signature
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey))
  } catch {
    return false
  }
}

// --- NIP-72 Community Events ---

export async function buildCommunityDefinitionEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  dTag: string
  name: string
  description?: string | null
  image?: string | null
  moderatorPubkeys?: string[]
  relayUrl?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.dTag],
    ['name', params.name],
  ]
  if (params.description) {
    tags.push(['description', params.description])
  }
  if (params.image) {
    tags.push(['image', params.image])
  }
  const relay = params.relayUrl || ''
  if (params.moderatorPubkeys) {
    for (const pk of params.moderatorPubkeys) {
      tags.push(['p', pk, relay, 'moderator'])
    }
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 34550,
    content: '',
    tags,
  })
}

export async function buildApprovalEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  communityPubkey: string
  dTag: string
  approvedEvent: NostrEvent
  relayUrl?: string
}): Promise<NostrEvent> {
  const relay = params.relayUrl || ''
  const tags: string[][] = [
    ['a', `34550:${params.communityPubkey}:${params.dTag}`, relay],
    ['e', params.approvedEvent.id, relay],
    ['p', params.approvedEvent.pubkey],
    ['k', String(params.approvedEvent.kind)],
  ]

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 4550,
    content: JSON.stringify(params.approvedEvent),
    tags,
  })
}

// --- Helpers ---

// --- Ledger Event Building (AIP-0002) ---

export const LEDGER_EVENT_KIND = 1112

export interface LedgerEventInfo {
  ledgerEntryId: string
  type: string
  amountSats: number
  balanceAfter: number
  signerType: 'system' | 'user'
  userPubkey?: string       // for user-signed events
  userPrivEncrypted?: string
  userPrivIv?: string
  counterpartyPubkey?: string
  refEventId?: string       // related DVM job event ID etc.
  memo?: string
}

/** Get or generate system Nostr keypair (stored in KV). */
export async function getSystemNostrKey(kv: KVNamespace, masterKey: string): Promise<{
  pubkey: string
  privEncrypted: string
  iv: string
}> {
  const existing = await kv.get('system_nostr_pubkey')
  if (existing) {
    const privEncrypted = await kv.get('system_nostr_priv_encrypted') || ''
    const iv = await kv.get('system_nostr_priv_iv') || ''
    return { pubkey: existing, privEncrypted, iv }
  }
  // Generate new system keypair
  const keypair = await generateNostrKeypair(masterKey)
  await kv.put('system_nostr_pubkey', keypair.pubkey)
  await kv.put('system_nostr_priv_encrypted', keypair.privEncrypted)
  await kv.put('system_nostr_priv_iv', keypair.iv)
  return keypair
}

/** Build and sign a Kind 1112 ledger event. */
export async function buildLedgerEvent(params: {
  info: LedgerEventInfo
  systemKey: { pubkey: string; privEncrypted: string; iv: string }
  masterKey: string
  prevSystemEventId?: string | null
}): Promise<NostrEvent> {
  const { info, systemKey, masterKey, prevSystemEventId } = params

  const tags: string[][] = [
    ['d', info.ledgerEntryId],
    ['t', info.type],
    ['amount', String(info.amountSats)],
    ['balance', String(info.balanceAfter)],
    ['L', '2020117.ledger'],
    ['l', info.type, '2020117.ledger'],
  ]

  if (info.counterpartyPubkey) {
    tags.push(['p', info.counterpartyPubkey, '', 'counterparty'])
  }
  if (info.refEventId) {
    tags.push(['e', info.refEventId, '', 'ref'])
  }
  // System-signed events form a chain via prev tag
  if (info.signerType === 'system' && prevSystemEventId) {
    tags.push(['e', prevSystemEventId, '', 'prev'])
  }

  // Determine signer
  let privEncrypted: string
  let iv: string
  if (info.signerType === 'user' && info.userPrivEncrypted && info.userPrivIv) {
    privEncrypted = info.userPrivEncrypted
    iv = info.userPrivIv
  } else {
    privEncrypted = systemKey.privEncrypted
    iv = systemKey.iv
  }

  return buildSignedEvent({
    privEncrypted,
    iv,
    masterKey,
    kind: LEDGER_EVENT_KIND,
    content: info.memo || '',
    tags,
  })
}

// --- Internal Helpers ---

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}
