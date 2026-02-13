// LNbits API wrapper — communicates with LNbits via Cloudflare Tunnel

export interface LnbitsInvoice {
  payment_hash: string
  payment_request: string
  checking_id: string
}

export interface LnbitsPaymentStatus {
  paid: boolean
  preimage?: string
  details?: Record<string, unknown>
}

/** Create a Lightning invoice (receive payment) */
export async function createInvoice(
  url: string,
  invoiceKey: string,
  amountSats: number,
  memo: string,
  webhookUrl?: string,
  unhashedDescription?: string,
): Promise<LnbitsInvoice> {
  const body: Record<string, unknown> = {
    out: false,
    amount: amountSats,
    memo,
    unit: 'sat',
  }
  if (webhookUrl) {
    body.webhook = webhookUrl
  }
  if (unhashedDescription) {
    body.unhashed_description = unhashedDescription
  }

  const resp = await fetch(`${url}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'X-Api-Key': invoiceKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`LNbits createInvoice failed (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<LnbitsInvoice>
}

/** Check if a payment has been received */
export async function checkPayment(
  url: string,
  invoiceKey: string,
  paymentHash: string,
): Promise<LnbitsPaymentStatus> {
  const resp = await fetch(`${url}/api/v1/payments/${paymentHash}`, {
    headers: { 'X-Api-Key': invoiceKey },
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`LNbits checkPayment failed (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<LnbitsPaymentStatus>
}

/** Pay a BOLT11 invoice (send payment) */
export async function payInvoice(
  url: string,
  adminKey: string,
  bolt11: string,
): Promise<{ payment_hash: string }> {
  const resp = await fetch(`${url}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'X-Api-Key': adminKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ out: true, bolt11 }),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`LNbits payInvoice failed (${resp.status}): ${text}`)
  }

  return resp.json() as Promise<{ payment_hash: string }>
}

/** Resolve a Lightning Address to a BOLT11 invoice, then pay it */
export async function payLightningAddress(
  url: string,
  adminKey: string,
  address: string,
  amountSats: number,
): Promise<{ payment_hash: string }> {
  // Parse address: user@domain
  const [user, domain] = address.split('@')
  if (!user || !domain) {
    throw new Error(`Invalid Lightning Address: ${address}`)
  }

  // Step 1: Fetch LNURL-pay metadata
  const wellKnownUrl = `https://${domain}/.well-known/lnurlp/${user}`
  const metaResp = await fetch(wellKnownUrl)
  if (!metaResp.ok) {
    throw new Error(`LNURL fetch failed (${metaResp.status}): ${wellKnownUrl}`)
  }

  const meta = await metaResp.json() as {
    callback: string
    minSendable: number
    maxSendable: number
    tag: string
  }

  if (meta.tag !== 'payRequest') {
    throw new Error(`Unexpected LNURL tag: ${meta.tag}`)
  }

  const amountMsats = amountSats * 1000
  if (amountMsats < meta.minSendable || amountMsats > meta.maxSendable) {
    throw new Error(`Amount ${amountSats} sats out of range [${meta.minSendable / 1000}-${meta.maxSendable / 1000}]`)
  }

  // Step 2: Request invoice from callback
  const separator = meta.callback.includes('?') ? '&' : '?'
  const callbackUrl = `${meta.callback}${separator}amount=${amountMsats}`
  const invoiceResp = await fetch(callbackUrl)
  if (!invoiceResp.ok) {
    throw new Error(`LNURL callback failed (${invoiceResp.status})`)
  }

  const invoiceData = await invoiceResp.json() as { pr: string }
  if (!invoiceData.pr) {
    throw new Error('No invoice returned from LNURL callback')
  }

  // Step 3: Pay the invoice
  return payInvoice(url, adminKey, invoiceData.pr)
}
