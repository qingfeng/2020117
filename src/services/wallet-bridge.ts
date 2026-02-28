/**
 * Wallet Bridge client (Kind 21120, NIP-44 v2).
 *
 * Sends RPC requests to Lightning Bridge instances over Nostr relay.
 * Protocol defined in AIP-0007.
 */

import { nip44, finalizeEvent, getPublicKey } from 'nostr-tools'
import { bytesToHex } from '@noble/hashes/utils.js'

// ---------------------------------------------------------------------------
// Platform key derivation (must match clink.ts getPlatformKey)
// ---------------------------------------------------------------------------

const platformKeyCache = new Map<string, { privBytes: Uint8Array; pubHex: string }>()

function getPlatformKeypair(masterKey: string) {
  let cached = platformKeyCache.get(masterKey)
  if (cached) return cached

  const seed = masterKey + ':clink-platform-identity'
  const bytes = new Uint8Array(32)
  const seedBytes = new TextEncoder().encode(seed)
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(masterKey.slice(i * 2, i * 2 + 2), 16) ^ seedBytes[i % seedBytes.length]
  }
  cached = { privBytes: bytes, pubHex: getPublicKey(bytes) }
  platformKeyCache.set(masterKey, cached)
  return cached
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const KIND = 21120

interface BridgeEnv {
  NOSTR_MASTER_KEY?: string
  NOSTR_RELAYS?: string
  LIGHTNING_BRIDGE_PUBKEY?: string
}

interface RpcRequest {
  id: string
  method: string
  params: Record<string, unknown>
}

interface RpcResponse {
  id: string
  result?: any
  error?: { code: number; message: string }
}

// ---------------------------------------------------------------------------
// Core RPC transport
// ---------------------------------------------------------------------------

function getRelayUrl(env: BridgeEnv): string {
  const relays = env.NOSTR_RELAYS?.split(',').map(r => r.trim()).filter(Boolean)
  if (!relays?.length) throw new Error('NOSTR_RELAYS not configured')
  return relays.find(r => r.includes('relay.2020117')) || relays[0]
}

/**
 * Send a Wallet RPC call to the Lightning Bridge via Kind 21120.
 */
export async function bridgeRpc(
  env: BridgeEnv,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<RpcResponse> {
  if (!env.NOSTR_MASTER_KEY) throw new Error('NOSTR_MASTER_KEY not configured')
  if (!env.LIGHTNING_BRIDGE_PUBKEY) throw new Error('LIGHTNING_BRIDGE_PUBKEY not configured')

  const { privBytes, pubHex } = getPlatformKeypair(env.NOSTR_MASTER_KEY)
  const bridgePubkey = env.LIGHTNING_BRIDGE_PUBKEY
  const relayUrl = getRelayUrl(env)

  // Generate request ID
  const idBytes = crypto.getRandomValues(new Uint8Array(16))
  const requestId = bytesToHex(idBytes)

  // Build RPC payload
  const rpcReq: RpcRequest = { id: requestId, method, params }

  // Encrypt with NIP-44 v2
  const conversationKey = nip44.v2.utils.getConversationKey(privBytes, bridgePubkey)
  const encrypted = nip44.v2.encrypt(JSON.stringify(rpcReq), conversationKey)

  // Sign event
  const signed = finalizeEvent({
    kind: KIND,
    content: encrypted,
    tags: [['p', bridgePubkey]],
    created_at: Math.floor(Date.now() / 1000),
  }, privBytes)

  // Send via WebSocket and wait for response
  return new Promise<RpcResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`Bridge RPC timeout (${method}, ${timeoutMs}ms)`))
    }, timeoutMs)

    const ws = new WebSocket(relayUrl)

    ws.addEventListener('open', () => {
      // Subscribe for response
      ws.send(JSON.stringify(['REQ', 'rpc-' + requestId.slice(0, 8), {
        kinds: [KIND],
        '#p': [pubHex],
        '#e': [signed.id],
        authors: [bridgePubkey],
        since: Math.floor(Date.now() / 1000) - 5,
      }]))
      // Publish request
      ws.send(JSON.stringify(['EVENT', signed]))
    })

    ws.addEventListener('message', (msg) => {
      try {
        const data = JSON.parse(typeof msg.data === 'string' ? msg.data : '')
        if (!Array.isArray(data)) return

        if (data[0] === 'EVENT') {
          const evt = data[2]
          if (!evt || evt.pubkey !== bridgePubkey) return

          // Check #e tag matches our request
          const eTag = evt.tags?.find((t: string[]) => t[0] === 'e')
          if (!eTag || eTag[1] !== signed.id) return

          // Decrypt response
          const plaintext = nip44.v2.decrypt(evt.content, conversationKey)
          const rpcRes: RpcResponse = JSON.parse(plaintext)

          if (rpcRes.id !== requestId) return

          clearTimeout(timer)
          try { ws.close() } catch {}
          resolve(rpcRes)
        }

        if (data[0] === 'OK' && data[1] === signed.id && data[2] === false) {
          clearTimeout(timer)
          try { ws.close() } catch {}
          reject(new Error(`Relay rejected event: ${data[3] || 'unknown'}`))
        }
      } catch {}
    })

    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`WebSocket error connecting to ${relayUrl}`))
    })
  })
}

// ---------------------------------------------------------------------------
// High-level wallet operations
// ---------------------------------------------------------------------------

function unwrap(res: RpcResponse): any {
  if (res.error) throw new Error(res.error.message)
  return res.result
}

/** Create a wallet sub-account for a user. */
export async function walletCreateUser(env: BridgeEnv, userId: string): Promise<void> {
  unwrap(await bridgeRpc(env, 'create_user', { user_id: userId }))
}

/** Get user wallet balance. */
export async function walletGetBalance(env: BridgeEnv, userId: string): Promise<{ balance_sats: number }> {
  return unwrap(await bridgeRpc(env, 'get_balance', { user_id: userId }))
}

/** Generate a Lightning invoice for deposits. */
export async function walletCreateInvoice(
  env: BridgeEnv, userId: string, amountSats: number, memo?: string,
): Promise<{ bolt11: string }> {
  return unwrap(await bridgeRpc(env, 'create_invoice', { user_id: userId, amount_sats: amountSats, memo }))
}

/** Pay a Lightning invoice (debit user balance). */
export async function walletPayInvoice(
  env: BridgeEnv, userId: string, bolt11: string,
): Promise<{ preimage: string; amount_sats: number }> {
  return unwrap(await bridgeRpc(env, 'pay_invoice', { user_id: userId, bolt11 }))
}

/** Internal transfer between two users. */
export async function walletInternalTransfer(
  env: BridgeEnv, fromUserId: string, toUserId: string, amountSats: number,
): Promise<void> {
  unwrap(await bridgeRpc(env, 'internal_transfer', {
    from_user_id: fromUserId, to_user_id: toUserId, amount_sats: amountSats,
  }))
}
