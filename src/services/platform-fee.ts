/**
 * Platform fee collection via CLINK ndebit.
 *
 * Providers sign an ndebit authorization to the platform when registering
 * their DVM service. A Cron job periodically calculates owed fees based on
 * earnings (totalEarnedMsats) minus already-billed amount (feeBilledMsats),
 * then debits the provider's wallet via CLINK.
 *
 * If debit fails, the provider is soft-banned: their service is deactivated
 * so they stop receiving new jobs via NIP-90 broadcast.
 */

import { eq, and, gt, sql } from 'drizzle-orm'
import { dvmServices } from '../db/schema'
import { debitForPayment, decryptNdebit } from './clink'
import type { Database } from '../db'
import type { Bindings } from '../types'

const MIN_FEE_SATS = 10  // don't bother collecting less than 10 sats

export async function collectPlatformFees(env: Bindings, db: Database) {
  const feePercent = parseFloat(env.PLATFORM_FEE_PERCENT || '0')
  const platformAddress = env.PLATFORM_LIGHTNING_ADDRESS || ''
  if (feePercent <= 0 || !platformAddress || !env.NOSTR_MASTER_KEY) {
    return  // platform fee not configured
  }

  // Find active services with ndebit that have uncollected earnings
  const services = await db.select({
    id: dvmServices.id,
    userId: dvmServices.userId,
    totalEarnedMsats: dvmServices.totalEarnedMsats,
    feeBilledMsats: dvmServices.feeBilledMsats,
    platformNdebitEncrypted: dvmServices.platformNdebitEncrypted,
    platformNdebitIv: dvmServices.platformNdebitIv,
  }).from(dvmServices)
    .where(and(
      eq(dvmServices.active, 1),
      sql`${dvmServices.platformNdebitEncrypted} IS NOT NULL`,
      gt(dvmServices.totalEarnedMsats, sql`COALESCE(${dvmServices.feeBilledMsats}, 0)`),
    ))

  for (const svc of services) {
    const earnedMsats = svc.totalEarnedMsats || 0
    const billedMsats = svc.feeBilledMsats || 0
    const unbilledMsats = earnedMsats - billedMsats
    const unbilledSats = Math.floor(unbilledMsats / 1000)
    const feeSats = Math.floor(unbilledSats * feePercent / 100)

    if (feeSats < MIN_FEE_SATS) continue

    try {
      const ndebit = await decryptNdebit(svc.platformNdebitEncrypted!, svc.platformNdebitIv!, env.NOSTR_MASTER_KEY!)
      const result = await debitForPayment({
        ndebit,
        lightningAddress: platformAddress,
        amountSats: feeSats,
        timeoutSeconds: 15,
      })

      if (result.ok) {
        // Mark the full unbilled amount as billed (not just feeSats, but the earnings base it came from)
        await db.update(dvmServices).set({
          feeBilledMsats: billedMsats + unbilledMsats,
          updatedAt: new Date(),
        }).where(eq(dvmServices.id, svc.id))
        console.log(`[PlatformFee] Collected ${feeSats} sats from service ${svc.id} (user ${svc.userId})`)
      } else {
        console.warn(`[PlatformFee] Debit rejected for service ${svc.id}: ${result.error}`)
        // Deactivate service — provider must re-register with valid ndebit
        await db.update(dvmServices).set({
          active: 0,
          updatedAt: new Date(),
        }).where(eq(dvmServices.id, svc.id))
        console.warn(`[PlatformFee] Deactivated service ${svc.id} due to failed fee collection`)
      }
    } catch (e) {
      console.error(`[PlatformFee] Error collecting from service ${svc.id}:`, e)
      // Don't deactivate on network errors — only on explicit rejection
    }
  }
}
