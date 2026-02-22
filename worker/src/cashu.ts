/**
 * Cashu eCash helper — mint, send, receive, melt tokens
 *
 * Uses testnut.cashu.space (fake sats) for PoC.
 * Switch to mint.coinos.io for production.
 */

import { Mint, Wallet, getEncodedToken, getDecodedToken, MintQuoteState } from '@cashu/cashu-ts'

const DEFAULT_MINT_URL = process.env.CASHU_MINT_URL || 'https://nofee.testnut.cashu.space'

export function createWallet(mintUrl = DEFAULT_MINT_URL) {
  const mint = new Mint(mintUrl)
  const wallet = new Wallet(mint)
  return { mint, wallet }
}

/**
 * Mint new tokens (testnut mints fake tokens without real Lightning payment)
 */
export async function mintTokens(amount: number, mintUrl = DEFAULT_MINT_URL) {
  const { wallet } = createWallet(mintUrl)
  await wallet.loadMint()

  // Request a mint quote
  const quote = await wallet.createMintQuote(amount)
  console.log(`[cashu] Mint quote created: ${quote.quote}`)

  // For testnut, quotes are auto-paid. For real mints, you'd pay the Lightning invoice.
  // Poll until quote is paid
  let state = quote.state
  for (let i = 0; i < 30 && state !== MintQuoteState.PAID; i++) {
    await sleep(1000)
    const check = await wallet.checkMintQuote(quote.quote)
    state = check.state
  }

  if (state !== MintQuoteState.PAID) {
    throw new Error(`Mint quote not paid after 30s (state: ${state}). For real mints, pay invoice: ${quote.request}`)
  }

  // Mint the tokens (v3.5 returns Proof[] directly)
  const proofs = await wallet.mintProofs(amount, quote.quote)
  console.log(`[cashu] Minted ${amount} sats (${proofs.length} proofs)`)

  // Encode as a portable token string
  const token = getEncodedToken({ mint: mintUrl, proofs })
  return { token, proofs }
}

/**
 * Verify and receive a Cashu token — swaps proofs with the mint to prevent double-spend
 */
export async function receiveToken(tokenStr: string) {
  const decoded = getDecodedToken(tokenStr)
  const mintUrl = decoded.mint
  if (!mintUrl) throw new Error('Token has no mint URL')

  const { wallet } = createWallet(mintUrl)
  await wallet.loadMint()

  // Swap proofs with the mint (this claims them, preventing re-use)
  const proofs = await wallet.receive(tokenStr)
  const total = proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
  console.log(`[cashu] Received ${total} sats from token (${proofs.length} proofs)`)

  return { proofs, amount: total, mintUrl }
}

/**
 * Get the total amount of a token without claiming it
 */
export function peekToken(tokenStr: string) {
  const decoded = getDecodedToken(tokenStr)
  const total = decoded.proofs.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
  return { amount: total, mint: decoded.mint, proofCount: decoded.proofs.length }
}

/**
 * Split a large token into multiple micro-tokens of a given amount.
 * Used for streaming payments: customer pre-splits budget into per-payment chunks.
 *
 * Example: splitTokens(token_100sats, 10) → 10 tokens of 10 sats each
 */
export async function splitTokens(tokenStr: string, perAmount: number): Promise<string[]> {
  const decoded = getDecodedToken(tokenStr)
  const mintUrl = decoded.mint
  if (!mintUrl) throw new Error('Token has no mint URL')

  const { wallet } = createWallet(mintUrl)
  await wallet.loadMint()

  const microTokens: string[] = []
  let remaining = decoded.proofs

  while (true) {
    const total = remaining.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)
    if (total < perAmount) break

    const { send, keep } = await wallet.send(perAmount, remaining)
    microTokens.push(getEncodedToken({ mint: mintUrl, proofs: send }))
    remaining = keep

    if (keep.length === 0) break
  }

  console.log(`[cashu] Split into ${microTokens.length} micro-tokens of ${perAmount} sats each`)
  return microTokens
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
