/**
 * Standalone NWC (NIP-47) client for sovereign mode.
 * Agent directly manages its own wallet without platform proxy.
 */

import { signEvent, nip04Encrypt, nip04Decrypt, pubkeyFromPrivkey } from './nostr.js'
import type { NostrEvent } from './nostr.js'
import WebSocket from 'ws'

// --- Types ---

export interface NwcParsed {
  walletPubkey: string
  relayUrl: string
  secret: string
}

// --- Parse ---

export function parseNwcUri(uri: string): NwcParsed {
  if (!uri.startsWith('nostr+walletconnect://')) {
    throw new Error('Invalid NWC URI: must start with nostr+walletconnect://')
  }

  const withoutScheme = uri.slice('nostr+walletconnect://'.length)
  const questionIdx = withoutScheme.indexOf('?')
  if (questionIdx === -1) throw new Error('Invalid NWC URI: missing query parameters')

  const walletPubkey = withoutScheme.slice(0, questionIdx)
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error('Invalid NWC URI: wallet pubkey must be 64 hex chars')
  }

  const params = new URLSearchParams(withoutScheme.slice(questionIdx + 1))
  const relayUrl = params.get('relay')
  const secret = params.get('secret')

  if (!relayUrl) throw new Error('Invalid NWC URI: missing relay parameter')
  if (!secret || !/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('Invalid NWC URI: missing or invalid secret parameter')
  }

  return { walletPubkey, relayUrl, secret }
}

// --- NWC Request Engine ---

async function nwcRequest(parsed: NwcParsed, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const { walletPubkey, relayUrl, secret } = parsed

  const content = JSON.stringify({ method, params })
  const encrypted = await nip04Encrypt(secret, walletPubkey, content)

  // Sign with the NWC secret key (it IS a Nostr private key)
  const event = signEvent({
    kind: 23194,
    tags: [['p', walletPubkey]],
    content: encrypted,
  }, secret)

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { ws.close() } catch {}
      reject(new Error(`NWC ${method} timeout (30s)`))
    }, 30_000)

    const ws = new WebSocket(relayUrl)

    ws.on('open', () => {
      const subId = Math.random().toString(36).slice(2, 10)
      // Subscribe for wallet response
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [23195],
        authors: [walletPubkey],
        '#e': [event.id],
        limit: 1,
      }]))
      // Send our request
      ws.send(JSON.stringify(['EVENT', event]))
    })

    ws.on('message', async (data: any) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg[0] === 'EVENT' && msg[2]?.kind === 23195) {
          clearTimeout(timeout)
          const decrypted = await nip04Decrypt(secret, walletPubkey, msg[2].content)
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

    ws.on('error', () => {
      clearTimeout(timeout)
      reject(new Error('NWC WebSocket connection failed'))
    })
  })
}

// --- Public API ---

export async function nwcGetBalance(parsed: NwcParsed): Promise<{ balance_msats: number }> {
  const result = await nwcRequest(parsed, 'get_balance')
  return { balance_msats: result?.balance || 0 }
}

export async function nwcPayInvoice(parsed: NwcParsed, bolt11: string): Promise<{ preimage: string }> {
  const result = await nwcRequest(parsed, 'pay_invoice', { invoice: bolt11 })
  return { preimage: result?.preimage || '' }
}

export async function nwcMakeInvoice(parsed: NwcParsed, amountMsats: number, description?: string): Promise<{ bolt11: string; payment_hash: string }> {
  const result = await nwcRequest(parsed, 'make_invoice', {
    amount: amountMsats,
    description: description || '',
  })
  return { bolt11: result?.invoice || '', payment_hash: result?.payment_hash || '' }
}

export async function nwcGetInfo(parsed: NwcParsed): Promise<{ supported_methods: string[] }> {
  const result = await nwcRequest(parsed, 'get_info')
  return { supported_methods: result?.methods || [] }
}

/** Resolve a Lightning Address to a bolt11 invoice and pay via NWC. */
export async function nwcPayLightningAddress(
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
