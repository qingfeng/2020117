/**
 * Lightning payment utilities — invoice generation via LNURL-pay
 *
 * Provider generates invoices from their own Lightning Address.
 * Customer pays invoices via built-in wallet (POST /api/wallet/send).
 */

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
