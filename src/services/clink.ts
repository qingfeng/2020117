/**
 * Server-side CLINK debit service — replaces NWC for DVM job payments.
 *
 * Uses @shocknet/clink-sdk to send debit requests to customer wallets
 * via Nostr relay (Kind 21002, NIP-44 encrypted).
 *
 * The platform generates an invoice from the provider's Lightning Address
 * (LNURL-pay), then debits the customer's wallet via their ndebit authorization.
 */

import { ClinkSDK, decodeBech32, newNdebitPaymentRequest, generateSecretKey, getPublicKey } from '@shocknet/clink-sdk'
import { encryptPrivkey, decryptNostrPrivkey } from './nostr'

// --- Platform CLINK identity (ephemeral per Worker instance) ---

let platformKey: Uint8Array | null = null

function getPlatformKey(): Uint8Array {
  if (!platformKey) {
    platformKey = generateSecretKey()
  }
  return platformKey
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
 */
export async function debitForPayment(opts: {
  ndebit: string              // customer's decrypted ndebit1... authorization
  lightningAddress: string    // recipient's Lightning Address (provider or platform)
  amountSats: number
  timeoutSeconds?: number
}): Promise<ServerDebitResult> {
  const { ndebit, lightningAddress, amountSats, timeoutSeconds = 30 } = opts

  // Step 1: Generate invoice from recipient's Lightning Address
  const bolt11 = await resolveInvoice(lightningAddress, amountSats)

  // Step 2: Send debit request to customer's wallet
  const decoded = decodeBech32(ndebit)
  if (decoded.type !== 'ndebit') {
    return { ok: false, error: `Invalid ndebit (type: ${decoded.type})` }
  }

  const sdk = new ClinkSDK({
    privateKey: getPlatformKey(),
    relays: [decoded.data.relay],
    toPubKey: decoded.data.pubkey,
    defaultTimeoutSeconds: timeoutSeconds,
  })

  const result = await sdk.Ndebit(
    newNdebitPaymentRequest(bolt11, undefined, decoded.data.pointer),
  )

  if (result.res === 'ok') {
    return { ok: true, preimage: (result as any).preimage }
  }
  return { ok: false, error: (result as any).error || 'Debit rejected' }
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
