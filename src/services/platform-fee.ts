/**
 * Platform fee collection via CLINK ndebit — triggered per-provider on heartbeat.
 *
 * When a provider sends a heartbeat, we check if they have uncollected fees
 * (totalEarnedMsats - feeBilledMsats) and debit via their platform ndebit.
 *
 * Guards:
 *   - Minimum 10 sats fee before collecting (avoid pointless tiny payments)
 *   - At least 10 minutes between collections (don't collect on every heartbeat)
 *
 * If debit is explicitly rejected, the service is deactivated — provider must
 * re-register with a valid ndebit to resume receiving jobs.
 */

import { eq } from 'drizzle-orm'
import { dvmServices } from '../db/schema'
import { debitForPayment, decryptNdebit } from './clink'
import type { Database } from '../db'

const MIN_FEE_SATS = 10          // minimum fee worth collecting
const COLLECT_INTERVAL_S = 600   // 10 minutes between collection attempts

export interface FeeResult {
  collected: boolean
  fee_sats?: number
  error?: string
}

/**
 * Attempt to collect platform fee from a single provider.
 * Called from POST /api/heartbeat — no table scan, just one provider.
 */
export async function collectProviderFee(opts: {
  db: Database
  userId: string
  feePercent: number
  platformAddress: string
  masterKey: string
}): Promise<FeeResult> {
  const { db, userId, feePercent, platformAddress, masterKey } = opts

  if (feePercent <= 0 || !platformAddress) {
    return { collected: false }
  }

  const svc = await db.select({
    id: dvmServices.id,
    totalEarnedMsats: dvmServices.totalEarnedMsats,
    feeBilledMsats: dvmServices.feeBilledMsats,
    lastFeeAt: dvmServices.lastFeeAt,
    platformNdebitEncrypted: dvmServices.platformNdebitEncrypted,
    platformNdebitIv: dvmServices.platformNdebitIv,
  }).from(dvmServices)
    .where(eq(dvmServices.userId, userId))
    .limit(1)

  if (svc.length === 0 || !svc[0].platformNdebitEncrypted || !svc[0].platformNdebitIv) {
    return { collected: false }
  }

  const s = svc[0]

  // Time guard: don't collect more than once per 10 minutes
  const now = Math.floor(Date.now() / 1000)
  if (s.lastFeeAt && (now - s.lastFeeAt) < COLLECT_INTERVAL_S) {
    return { collected: false }
  }

  // Amount guard: need enough unbilled earnings
  const earnedMsats = s.totalEarnedMsats || 0
  const billedMsats = s.feeBilledMsats || 0
  const unbilledMsats = earnedMsats - billedMsats
  if (unbilledMsats <= 0) return { collected: false }

  const unbilledSats = Math.floor(unbilledMsats / 1000)
  const feeSats = Math.floor(unbilledSats * feePercent / 100)
  if (feeSats < MIN_FEE_SATS) return { collected: false }

  try {
    const ndebit = await decryptNdebit(s.platformNdebitEncrypted!, s.platformNdebitIv!, masterKey)
    const result = await debitForPayment({
      ndebit,
      lightningAddress: platformAddress,
      amountSats: feeSats,
      timeoutSeconds: 15,
    })

    if (result.ok) {
      await db.update(dvmServices).set({
        feeBilledMsats: billedMsats + unbilledMsats,
        lastFeeAt: now,
        updatedAt: new Date(),
      }).where(eq(dvmServices.id, s.id))
      console.log(`[PlatformFee] Collected ${feeSats} sats from user ${userId}`)
      return { collected: true, fee_sats: feeSats }
    } else {
      console.warn(`[PlatformFee] Debit rejected for user ${userId}: ${result.error}`)
      await db.update(dvmServices).set({
        active: 0,
        updatedAt: new Date(),
      }).where(eq(dvmServices.id, s.id))
      return { collected: false, error: result.error }
    }
  } catch (e) {
    console.error(`[PlatformFee] Error collecting from user ${userId}:`, e)
    return { collected: false, error: e instanceof Error ? e.message : 'Unknown error' }
  }
}
