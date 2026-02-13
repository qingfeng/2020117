import { eq, sql } from 'drizzle-orm'
import type { Database } from '../db'
import { users, ledgerEntries } from '../db/schema'
import { generateId } from './utils'
import type { LedgerEventInfo } from '../services/nostr'
import { buildLedgerEvent, getSystemNostrKey } from '../services/nostr'
import type { NostrEvent } from '../services/nostr'

// ─── Types ───

export interface LedgerResult {
  ok: boolean
  entries: LedgerEventInfo[]
}

// ─── Atomic primitives ───

/** Debit (subtract) sats from user. Returns false if insufficient balance (CAS). */
export async function debitBalance(db: Database, userId: string, amountSats: number): Promise<boolean> {
  const result = await db.run(
    sql`UPDATE "user" SET balance_sats = balance_sats - ${amountSats} WHERE id = ${userId} AND balance_sats >= ${amountSats}`
  )
  return (result.meta?.changes ?? 0) > 0
}

/** Credit (add) sats to user. */
export async function creditBalance(db: Database, userId: string, amountSats: number): Promise<void> {
  await db.run(
    sql`UPDATE "user" SET balance_sats = balance_sats + ${amountSats} WHERE id = ${userId}`
  )
}

/** Get current balance. */
export async function getBalance(db: Database, userId: string): Promise<number> {
  const row = await db.select({ balanceSats: users.balanceSats }).from(users).where(eq(users.id, userId)).limit(1)
  return row.length > 0 ? row[0].balanceSats : 0
}

/** Record a ledger entry. Returns the entry ID. */
export async function recordLedger(db: Database, entry: {
  userId: string
  type: string
  amountSats: number
  balanceAfter: number
  refId?: string | null
  refType?: string | null
  memo?: string | null
}): Promise<string> {
  const id = generateId()
  await db.insert(ledgerEntries).values({
    id,
    userId: entry.userId,
    type: entry.type,
    amountSats: entry.amountSats,
    balanceAfter: entry.balanceAfter,
    refId: entry.refId || null,
    refType: entry.refType || null,
    memo: entry.memo || null,
    createdAt: new Date(),
  })
  return id
}

// ─── Composite operations ───
// Each returns LedgerResult with entry metadata for Nostr event publishing.

/** Freeze escrow: debit customer + ledger. */
export async function escrowFreeze(db: Database, userId: string, sats: number, jobId: string): Promise<LedgerResult> {
  const ok = await debitBalance(db, userId, sats)
  if (!ok) return { ok: false, entries: [] }
  const balance = await getBalance(db, userId)
  const memo = `Escrow freeze for job ${jobId}`
  const entryId = await recordLedger(db, {
    userId, type: 'escrow_freeze', amountSats: -sats, balanceAfter: balance,
    refId: jobId, refType: 'dvm_job', memo,
  })
  return {
    ok: true,
    entries: [{
      ledgerEntryId: entryId, type: 'escrow_freeze', amountSats: -sats,
      balanceAfter: balance, signerType: 'user', memo,
    }],
  }
}

/** Release escrow: credit provider + two ledger entries. */
export async function escrowRelease(
  db: Database, customerUserId: string, providerUserId: string, sats: number, jobId: string,
): Promise<LedgerResult> {
  await creditBalance(db, providerUserId, sats)

  const customerBalance = await getBalance(db, customerUserId)
  const releaseMemo = `Escrow released for job ${jobId}`
  const releaseId = await recordLedger(db, {
    userId: customerUserId, type: 'escrow_release', amountSats: 0,
    balanceAfter: customerBalance, refId: jobId, refType: 'dvm_job', memo: releaseMemo,
  })

  const providerBalance = await getBalance(db, providerUserId)
  const paymentMemo = `Payment for job ${jobId}`
  const paymentId = await recordLedger(db, {
    userId: providerUserId, type: 'job_payment', amountSats: sats,
    balanceAfter: providerBalance, refId: jobId, refType: 'dvm_job', memo: paymentMemo,
  })

  return {
    ok: true,
    entries: [
      {
        ledgerEntryId: releaseId, type: 'escrow_release', amountSats: 0,
        balanceAfter: customerBalance, signerType: 'system', memo: releaseMemo,
      },
      {
        ledgerEntryId: paymentId, type: 'job_payment', amountSats: sats,
        balanceAfter: providerBalance, signerType: 'system', memo: paymentMemo,
      },
    ],
  }
}

/** Refund escrow: credit customer + ledger. */
export async function escrowRefund(db: Database, userId: string, sats: number, jobId: string): Promise<LedgerResult> {
  await creditBalance(db, userId, sats)
  const balance = await getBalance(db, userId)
  const memo = `Escrow refund for job ${jobId}`
  const entryId = await recordLedger(db, {
    userId, type: 'escrow_refund', amountSats: sats, balanceAfter: balance,
    refId: jobId, refType: 'dvm_job', memo,
  })
  return {
    ok: true,
    entries: [{
      ledgerEntryId: entryId, type: 'escrow_refund', amountSats: sats,
      balanceAfter: balance, signerType: 'system', memo,
    }],
  }
}

/** Transfer sats between users. */
export async function transfer(
  db: Database, fromId: string, toId: string, sats: number, memo?: string,
): Promise<LedgerResult> {
  const ok = await debitBalance(db, fromId, sats)
  if (!ok) return { ok: false, entries: [] }

  await creditBalance(db, toId, sats)

  const fromBalance = await getBalance(db, fromId)
  const toBalance = await getBalance(db, toId)
  const transferId = generateId()

  const outId = await recordLedger(db, {
    userId: fromId, type: 'transfer_out', amountSats: -sats,
    balanceAfter: fromBalance, refId: transferId, refType: 'transfer', memo: memo || null,
  })
  const inId = await recordLedger(db, {
    userId: toId, type: 'transfer_in', amountSats: sats,
    balanceAfter: toBalance, refId: transferId, refType: 'transfer', memo: memo || null,
  })

  return {
    ok: true,
    entries: [
      {
        ledgerEntryId: outId, type: 'transfer_out', amountSats: -sats,
        balanceAfter: fromBalance, signerType: 'user', memo: memo || undefined,
      },
      {
        ledgerEntryId: inId, type: 'transfer_in', amountSats: sats,
        balanceAfter: toBalance, signerType: 'system', memo: memo || undefined,
      },
    ],
  }
}

// ─── Nostr Event Publishing (GEP-0009) ───

/** Publish ledger entries as signed Nostr events. Call in waitUntil(). */
export async function publishLedgerEvents(
  db: Database,
  kv: KVNamespace,
  queue: Queue,
  masterKey: string,
  entries: LedgerEventInfo[],
  userKeys?: { pubkey: string; privEncrypted: string; iv: string },
): Promise<void> {
  if (entries.length === 0) return

  const systemKey = await getSystemNostrKey(kv, masterKey)
  let prevSystemEventId = await kv.get('ledger_prev_system_event_id')

  const events: NostrEvent[] = []

  for (const info of entries) {
    // Attach user keys for user-signed events
    if (info.signerType === 'user' && userKeys) {
      info.userPubkey = userKeys.pubkey
      info.userPrivEncrypted = userKeys.privEncrypted
      info.userPrivIv = userKeys.iv
    }

    const event = await buildLedgerEvent({
      info,
      systemKey,
      masterKey,
      prevSystemEventId: info.signerType === 'system' ? prevSystemEventId : null,
    })

    events.push(event)

    // Update chain pointer for system events
    if (info.signerType === 'system') {
      prevSystemEventId = event.id
    }

    // Write back event ID to ledger_entry
    await db.update(ledgerEntries)
      .set({ nostrEventId: event.id })
      .where(eq(ledgerEntries.id, info.ledgerEntryId))
  }

  // Persist latest system event ID for chain
  if (prevSystemEventId) {
    await kv.put('ledger_prev_system_event_id', prevSystemEventId)
  }

  // Queue all events for relay publishing
  for (const event of events) {
    await queue.send({ type: 'nostr-event', event })
  }
}
