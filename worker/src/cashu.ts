/**
 * Cashu eCash utilities — send and receive tokens over P2P
 *
 * Customer: pre-loads tokens, splits per billing tick, sends to Provider
 * Provider: receives tokens, swaps at mint to verify, accumulates proofs
 */

import { CashuMint, CashuWallet, getEncodedTokenV4, getDecodedToken } from '@cashu/cashu-ts'

// Proof type not re-exported under nodenext resolution; define locally
export type Proof = { id: string; amount: number; secret: string; C: string }

// Cache wallet instances per mint URL
const walletCache = new Map<string, CashuWallet>()

async function getWallet(mintUrl: string): Promise<CashuWallet> {
  let wallet = walletCache.get(mintUrl)
  if (!wallet) {
    const mint = new CashuMint(mintUrl)
    wallet = new CashuWallet(mint)
    await wallet.loadMint()
    walletCache.set(mintUrl, wallet)
  }
  return wallet
}

/**
 * Split proofs to create a Cashu token of the exact amount.
 * Returns the encoded token string and remaining change proofs.
 */
export async function sendCashuToken(
  mintUrl: string,
  proofs: Proof[],
  amount: number,
): Promise<{ token: string; change: Proof[] }> {
  const wallet = await getWallet(mintUrl)
  const { send, keep } = await wallet.send(amount, proofs)
  const token = getEncodedTokenV4({ mint: mintUrl, proofs: send })
  return { token, change: keep }
}

/**
 * Verify and claim a Cashu token — swaps proofs with the mint to prevent double-spend.
 * Returns the claimed proofs (now owned by the receiver).
 */
export async function receiveCashuToken(
  tokenStr: string,
): Promise<{ proofs: Proof[]; amount: number; mintUrl: string }> {
  const decoded = getDecodedToken(tokenStr)
  const mintUrl = decoded.mint
  const wallet = await getWallet(mintUrl)
  const proofs = await wallet.receive(tokenStr)
  const amount = proofs.reduce((sum, p) => sum + p.amount, 0)
  return { proofs, amount, mintUrl }
}

/**
 * Inspect a token's amount and mint without claiming it.
 */
export function peekCashuToken(tokenStr: string): { amount: number; mint: string } {
  const decoded = getDecodedToken(tokenStr)
  const amount = decoded.proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
  return { amount, mint: decoded.mint }
}

/**
 * Decode a token string to get the raw proofs and mint URL.
 */
export function decodeCashuToken(tokenStr: string): { mint: string; proofs: Proof[] } {
  const decoded = getDecodedToken(tokenStr)
  return { mint: decoded.mint, proofs: decoded.proofs }
}

/**
 * Encode proofs back into a portable token string.
 */
export function encodeCashuToken(mintUrl: string, proofs: Proof[]): string {
  return getEncodedTokenV4({ mint: mintUrl, proofs })
}

/**
 * Melt proofs back into a Lightning invoice — converts Cashu back to Lightning.
 * Returns the payment preimage and any change proofs.
 */
export async function meltProofs(
  mintUrl: string,
  proofs: Proof[],
  invoice: string,
): Promise<{ preimage: string; change: Proof[] }> {
  const wallet = await getWallet(mintUrl)
  const meltQuote = await wallet.createMeltQuote(invoice)
  const amountNeeded = meltQuote.amount + meltQuote.fee_reserve
  const total = proofs.reduce((s, p) => s + p.amount, 0)
  if (total < amountNeeded) {
    throw new Error(`Need ${amountNeeded} sats (invoice ${meltQuote.amount} + fee ${meltQuote.fee_reserve}) but only have ${total}`)
  }
  const { send, keep } = await wallet.send(amountNeeded, proofs, { includeFees: true })
  const result = await wallet.meltProofs(meltQuote, send)
  const change = [...keep, ...(result.change || [])]
  return { preimage: result.quote.payment_preimage || '', change }
}

/**
 * Estimate total cost to melt (invoice amount + fee_reserve) for a given invoice.
 */
export async function estimateMeltFee(
  mintUrl: string,
  invoice: string,
): Promise<{ amount: number; fee: number; total: number }> {
  const wallet = await getWallet(mintUrl)
  const quote = await wallet.createMeltQuote(invoice)
  return { amount: quote.amount, fee: quote.fee_reserve, total: quote.amount + quote.fee_reserve }
}

/**
 * Request a mint quote — returns a Lightning invoice to pay for minting tokens.
 */
export async function createMintQuote(
  mintUrl: string,
  amountSats: number,
): Promise<{ quote: string; invoice: string }> {
  const wallet = await getWallet(mintUrl)
  const quoteRes = await wallet.createMintQuote(amountSats)
  return { quote: quoteRes.quote, invoice: quoteRes.request }
}

/**
 * Claim a paid mint quote — polls for payment, then mints proofs and returns an encoded token.
 * Throws if the quote is not paid within the timeout.
 */
export async function claimMintQuote(
  mintUrl: string,
  amountSats: number,
  quoteId: string,
  timeoutMs = 60_000,
): Promise<string> {
  const wallet = await getWallet(mintUrl)

  // Poll until paid or timeout
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const check = await wallet.checkMintQuote(quoteId)
    if (check.state === 'PAID') {
      const proofs = await wallet.mintProofs(amountSats, quoteId)
      return getEncodedTokenV4({ mint: mintUrl, proofs })
    }
    if (check.state === 'ISSUED') {
      throw new Error('Mint quote already issued')
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Mint quote payment timeout')
}

