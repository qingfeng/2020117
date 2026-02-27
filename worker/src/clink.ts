/**
 * CLINK payment utilities — replaces Cashu for P2P payments
 *
 * Provider uses ndebit to pull payments from customer's wallet.
 * Invoice generation via LNURL-pay from provider's own Lightning Address.
 */

import { ClinkSDK, decodeBech32, generateSecretKey, getPublicKey, newNdebitPaymentRequest } from '@shocknet/clink-sdk'

// --- Agent identity ---

let agentKey: Uint8Array | null = null
let agentPubkey: string | null = null

export function initClinkAgent(): { privateKey: Uint8Array; pubkey: string } {
  agentKey = generateSecretKey()
  agentPubkey = getPublicKey(agentKey)
  console.log(`[clink] Agent identity: ${agentPubkey.slice(0, 16)}...`)
  return { privateKey: agentKey, pubkey: agentPubkey }
}

// --- Debit (pull payment from customer) ---

export interface DebitResult {
  ok: boolean
  preimage?: string
  error?: string
}

/**
 * Provider calls this to debit customer's wallet via CLINK protocol.
 * Sends a Kind 21002 event to the customer's wallet service via Nostr relay.
 */
export async function debitCustomer(opts: {
  ndebit: string           // customer's ndebit1... authorization
  bolt11: string           // provider-generated invoice (pays provider)
  timeoutSeconds?: number
}): Promise<DebitResult> {
  if (!agentKey) throw new Error('CLINK agent not initialized — call initClinkAgent() first')

  const decoded = decodeBech32(opts.ndebit)
  if (decoded.type !== 'ndebit') throw new Error(`Invalid ndebit string (got type: ${decoded.type})`)

  const sdk = new ClinkSDK({
    privateKey: agentKey,
    relays: [decoded.data.relay],
    toPubKey: decoded.data.pubkey,
    defaultTimeoutSeconds: opts.timeoutSeconds ?? 30,
  })

  const result = await sdk.Ndebit(
    newNdebitPaymentRequest(opts.bolt11, undefined, decoded.data.pointer),
  )

  if (result.res === 'ok') {
    return { ok: true, preimage: (result as any).preimage }
  }
  return { ok: false, error: (result as any).error || 'Debit rejected' }
}

// --- Invoice generation via LNURL-pay ---

/**
 * Resolve a Lightning Address to a bolt11 invoice via LNURL-pay protocol.
 * The provider calls this on their OWN Lightning Address to generate
 * an invoice that pays themselves.
 *
 * Flow: address → .well-known/lnurlp → callback?amount= → bolt11
 */
export async function generateInvoice(lightningAddress: string, amountSats: number): Promise<string> {
  const [user, domain] = lightningAddress.split('@')
  if (!user || !domain) throw new Error(`Invalid Lightning Address: ${lightningAddress}`)

  // Step 1: Fetch LNURL-pay metadata
  const metaUrl = `https://${domain}/.well-known/lnurlp/${user}`
  const metaResp = await fetch(metaUrl)
  if (!metaResp.ok) throw new Error(`LNURL fetch failed: ${metaResp.status} from ${metaUrl}`)

  const meta = await metaResp.json() as {
    callback: string
    minSendable: number  // msats
    maxSendable: number  // msats
    tag: string
  }

  if (meta.tag !== 'payRequest') throw new Error(`Not a LNURL-pay endpoint (tag: ${meta.tag})`)

  const amountMsats = amountSats * 1000
  if (amountMsats < meta.minSendable) throw new Error(`Amount ${amountSats} sats below min ${meta.minSendable / 1000} sats`)
  if (amountMsats > meta.maxSendable) throw new Error(`Amount ${amountSats} sats above max ${meta.maxSendable / 1000} sats`)

  // Step 2: Request invoice from callback
  const sep = meta.callback.includes('?') ? '&' : '?'
  const invoiceUrl = `${meta.callback}${sep}amount=${amountMsats}`
  const invoiceResp = await fetch(invoiceUrl)
  if (!invoiceResp.ok) throw new Error(`Invoice request failed: ${invoiceResp.status}`)

  const invoiceData = await invoiceResp.json() as { pr?: string; reason?: string }
  if (!invoiceData.pr) throw new Error(`No invoice returned: ${invoiceData.reason || 'unknown error'}`)

  return invoiceData.pr
}

// --- Combined: generate invoice + debit ---

/**
 * Full payment cycle: generate invoice from provider's Lightning Address,
 * then debit customer's wallet via CLINK.
 */
export async function collectPayment(opts: {
  ndebit: string              // customer's ndebit authorization
  lightningAddress: string    // provider's Lightning Address
  amountSats: number          // amount to collect
  timeoutSeconds?: number
}): Promise<DebitResult> {
  const bolt11 = await generateInvoice(opts.lightningAddress, opts.amountSats)
  return debitCustomer({
    ndebit: opts.ndebit,
    bolt11,
    timeoutSeconds: opts.timeoutSeconds,
  })
}
