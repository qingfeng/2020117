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

