import { schnorr } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'
import type { NostrEvent } from './types'

/**
 * Verify a Nostr event: check id hash + Schnorr signature
 */
export function verifyEvent(event: NostrEvent): boolean {
  try {
    // Verify event ID = sha256([0, pubkey, created_at, kind, tags, content])
    const serialized = JSON.stringify([
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ])
    const expectedId = bytesToHex(sha256(new TextEncoder().encode(serialized)))
    if (event.id !== expectedId) return false

    // Verify Schnorr signature
    return schnorr.verify(
      hexToBytes(event.sig),
      hexToBytes(event.id),
      hexToBytes(event.pubkey),
    )
  } catch {
    return false
  }
}
