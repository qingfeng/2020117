import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { dvmJobs, dvmServices, dvmTrust, users, nostrReports, externalDvms, agentHeartbeats, dvmReviews, dvmWorkflows, dvmWorkflowSteps, dvmEndorsements, relayEvents, dvmAttestations } from '../db/schema'
import { type NostrEvent, verifyEvent } from './nostr'
import { fetchEventsFromRelay } from './nostr-community'
import { generateId, ensureUniqueUsername } from '../lib/utils'
import { buildJobRequestEvent } from './dvm-events'

// --- Cron: Poll DVM Results (for customers) ---

// When a 6xxx result arrives but the 5xxx request was never indexed, fetch the original
// request from relay, create the customer job record, and write the result.
async function backfillCustomerJob(db: Database, relayUrl: string, requestEventId: string, resultEvent: NostrEvent): Promise<void> {
  try {
    // Check if a customer job for this request already exists (any status)
    const existing = await db.select({ id: dvmJobs.id })
      .from(dvmJobs)
      .where(and(eq(dvmJobs.requestEventId, requestEventId), eq(dvmJobs.role, 'customer')))
      .limit(1)
    if (existing.length > 0) return

    // Fetch the original 5xxx request event from relay
    const fetched = await fetchEventsFromRelay(relayUrl, { ids: [requestEventId] })
    if (!fetched.events.length) {
      console.log(`[DVM] Backfill: 5xxx request ${requestEventId.slice(0, 8)}... not found on relay`)
      return
    }

    const requestEvent = fetched.events[0]
    if (!verifyEvent(requestEvent)) return

    const userId = await ensureUserForPubkey(db, requestEvent.pubkey)
    if (!userId) return

    const amountTag = resultEvent.tags.find(t => t[0] === 'amount')
    const bolt11 = amountTag?.[2] || null
    const priceMsats = amountTag?.[1] ? parseInt(amountTag[1]) : null

    const inputTag = requestEvent.tags.find(t => t[0] === 'i')
    const input = inputTag?.[1] || requestEvent.content || null
    const inputType = inputTag?.[2] || null

    const jobId = generateId()
    await db.insert(dvmJobs).values({
      id: jobId,
      userId,
      role: 'customer',
      kind: requestEvent.kind,
      status: 'result_available',
      input,
      inputType,
      result: resultEvent.content,
      requestEventId,
      resultEventId: resultEvent.id,
      customerPubkey: requestEvent.pubkey,
      providerPubkey: resultEvent.pubkey,
      bolt11,
      priceMsats,
      createdAt: new Date(requestEvent.created_at * 1000),
      updatedAt: new Date(),
    })
    console.log(`[DVM] Backfilled customer job ${jobId} for request ${requestEventId.slice(0, 8)}... result ${resultEvent.id.slice(0, 8)}...`)
  } catch (e) {
    console.error(`[DVM] Backfill failed for request ${requestEventId.slice(0, 8)}...:`, e)
  }
}

export async function pollDvmResults(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Find active customer jobs waiting for results
  const activeJobs = await db
    .select({
      id: dvmJobs.id,
      requestEventId: dvmJobs.requestEventId,
      kind: dvmJobs.kind,
      status: dvmJobs.status,
      providerPubkey: dvmJobs.providerPubkey,
      updatedAt: dvmJobs.updatedAt,
    })
    .from(dvmJobs)
    .where(and(
      eq(dvmJobs.role, 'customer'),
      inArray(dvmJobs.status, ['open', 'processing', 'result_available']),
      isNotNull(dvmJobs.requestEventId),
    ))

  if (activeJobs.length === 0) return

  const requestEventIds = activeJobs
    .map(j => j.requestEventId)
    .filter((id): id is string => !!id)

  if (requestEventIds.length === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_results_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600

  const relayUrl = relayUrls[0]

  // Poll for Job Results and Feedback (Kind 7000)
  // Derive actual result kinds from active jobs (request kind + 1000)
  const resultKinds = [...new Set(activeJobs.map(j => j.kind + 1000))]
  const BATCH_SIZE = 50
  let maxCreatedAt = since

  for (let i = 0; i < requestEventIds.length; i += BATCH_SIZE) {
    const batch = requestEventIds.slice(i, i + BATCH_SIZE)

    try {
      // Query result kinds derived from active request kinds
      const resultRelay = await fetchEventsFromRelay(relayUrl, {
        kinds: resultKinds,
        '#e': batch,
        since,
      })

      // Query Kind 7000 feedback
      const feedbackRelay = await fetchEventsFromRelay(relayUrl, {
        kinds: [7000],
        '#e': batch,
        since,
      })

      // Sort ascending by created_at so newer events always win over older ones.
      // Relay returns DESC order, so without sorting a stale 'processing' event
      // processed after a newer 'error' event would incorrectly override it.
      const allEvents = [...resultRelay.events, ...feedbackRelay.events]
        .sort((a, b) => a.created_at - b.created_at)

      for (const event of allEvents) {
        if (!verifyEvent(event)) continue

        // Find which request this responds to
        const eTag = event.tags.find(t => t[0] === 'e')
        if (!eTag) continue
        const refEventId = eTag[1]

        const job = activeJobs.find(j => j.requestEventId === refEventId)
        if (!job) {
          // For 6xxx results: backfill missing customer job (5xxx request wasn't indexed by Cron)
          if (event.kind >= 6000 && event.kind <= 6999) {
            await backfillCustomerJob(db, relayUrl, refEventId, event)
          }
          continue
        }

        if (event.kind === 7000) {
          // Feedback event
          const statusTag = event.tags.find(t => t[0] === 'status')
          const feedbackStatus = statusTag?.[1]

          if (feedbackStatus === 'processing' && job.status === 'open') {
            await db.update(dvmJobs)
              .set({ status: 'processing', providerPubkey: event.pubkey, updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[DVM] Job ${job.id} → processing (provider: ${event.pubkey.slice(0, 8)}...)`)
          } else if (feedbackStatus === 'success') {
            await db.update(dvmJobs)
              .set({ status: 'completed', updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[DVM] Job ${job.id} → completed (Kind 7000 success)`)
          } else if (feedbackStatus === 'error') {
            // status=error from anyone → reset job to open so other providers can fulfill it
            // Provider failed: let others try. Customer rejected: same outcome.
            // Only status=success (after payment) truly closes a job.
            await db.update(dvmJobs)
              .set({ status: 'open', providerPubkey: null, updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            const who = event.pubkey === job.providerPubkey ? 'provider failed' : 'customer rejected'
            console.log(`[DVM] Job ${job.id} → open (${who}, 7000 error from ${event.pubkey.slice(0, 8)}...)`)
          }
        } else if (event.kind >= 6000 && event.kind <= 6999) {
          // Result event — extract bolt11 from amount tag
          const amountTag = event.tags.find(t => t[0] === 'amount')
          const bolt11 = amountTag?.[2] || null
          const priceMsats = amountTag?.[1] ? parseInt(amountTag[1]) : null

          // Extract lightning_address tag (sovereign agents include this)
          const laTag = event.tags.find((t: string[]) => t[0] === 'lightning_address')?.[1]

          // Skip if we already have this exact result event
          if (job.status === 'result_available') {
            const existing = await db.select({ resultEventId: dvmJobs.resultEventId })
              .from(dvmJobs).where(eq(dvmJobs.id, job.id)).limit(1)
            if (existing.length > 0 && existing[0].resultEventId === event.id) continue
          }

          await db.update(dvmJobs)
            .set({
              status: 'result_available',
              result: event.content,
              providerPubkey: event.pubkey,
              resultEventId: event.id,
              bolt11,
              priceMsats,
              updatedAt: new Date(),
            })
            .where(eq(dvmJobs.id, job.id))
          const wasUpdated = job.status === 'result_available' ? ' (updated)' : ''
          console.log(`[DVM] Job ${job.id} → result_available${wasUpdated} (provider: ${event.pubkey.slice(0, 8)}...${bolt11 ? ', has bolt11' : ''}${laTag ? ', has lightning_address' : ''})`)

          // Mark provider job as completed (if local provider has a matching record)
          const providerJob = await db.select({ id: dvmJobs.id, status: dvmJobs.status })
            .from(dvmJobs)
            .where(and(
              eq(dvmJobs.requestEventId, refEventId),
              eq(dvmJobs.role, 'provider'),
            ))
            .limit(1)
          if (providerJob.length > 0 && providerJob[0].status !== 'completed') {
            await db.update(dvmJobs)
              .set({ status: 'completed', result: event.content, resultEventId: event.id, updatedAt: new Date() })
              .where(eq(dvmJobs.id, providerJob[0].id))
            console.log(`[DVM] Provider job ${providerJob[0].id} → completed`)
          }

          // Backfill external_dvm lightning_address if present and not yet stored
          if (laTag) {
            const extDvm = await db.select({ id: externalDvms.id, lightningAddress: externalDvms.lightningAddress })
              .from(externalDvms)
              .where(eq(externalDvms.pubkey, event.pubkey))
              .limit(1)
            if (extDvm.length > 0 && !extDvm[0].lightningAddress) {
              await db.update(externalDvms)
                .set({ lightningAddress: laTag, updatedAt: new Date() })
                .where(eq(externalDvms.id, extDvm[0].id))
              console.log(`[DVM] Backfilled lightning_address for external DVM ${event.pubkey.slice(0, 8)}`)
            }
          }

          // Check if this job is part of a workflow — auto-advance
          try {
            await advanceWorkflow(db, env, job.id)
          } catch (e) {
            console.error(`[Workflow] Failed to advance after job ${job.id}:`, e)
          }
        }

        if (event.created_at > maxCreatedAt) {
          maxCreatedAt = event.created_at
        }
      }
    } catch (e) {
      console.error('[DVM] Failed to poll results batch:', e)
    }
  }

  // Update KV timestamp
  if (maxCreatedAt > since) {
    await kv.put(sinceKey, String(maxCreatedAt + 1))
  }

  // --- Stale processing check ---
  // Jobs stuck in 'processing' for >30min may have received a 7000 error BEFORE the
  // current `since` timestamp, so the incremental poll above would never see it.
  // Re-query relay WITHOUT the `since` filter for these jobs only.
  const STALE_THRESHOLD_MS = 30 * 60 * 1000
  const staleJobs = activeJobs.filter(j =>
    j.status === 'processing' &&
    j.updatedAt &&
    (Date.now() - new Date(j.updatedAt).getTime()) > STALE_THRESHOLD_MS
  )

  if (staleJobs.length > 0) {
    const staleIds = staleJobs.map(j => j.requestEventId).filter((id): id is string => !!id)
    console.log(`[DVM] Checking ${staleJobs.length} stale processing job(s) without since filter`)

    for (let i = 0; i < staleIds.length; i += BATCH_SIZE) {
      const batch = staleIds.slice(i, i + BATCH_SIZE)
      try {
        const staleFeedback = await fetchEventsFromRelay(relayUrl, {
          kinds: [7000],
          '#e': batch,
          // No `since` — we want ALL historical feedback
        })
        for (const event of staleFeedback.events) {
          if (!verifyEvent(event)) continue
          const eTag = event.tags.find(t => t[0] === 'e')
          if (!eTag) continue
          const refEventId = eTag[1]
          const job = staleJobs.find(j => j.requestEventId === refEventId)
          if (!job) continue

          const statusTag = event.tags.find(t => t[0] === 'status')
          const feedbackStatus = statusTag?.[1]

          if (feedbackStatus === 'error') {
            await db.update(dvmJobs)
              .set({ status: 'open', providerPubkey: null, updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            const who = event.pubkey === job.providerPubkey ? 'provider failed' : 'customer rejected'
            console.log(`[DVM] Stale job ${job.id} → open (${who}, historical 7000 error)`)
          } else if (feedbackStatus === 'success') {
            await db.update(dvmJobs)
              .set({ status: 'completed', updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[DVM] Stale job ${job.id} → completed (historical 7000 success)`)
          }
        }
      } catch (e) {
        console.error('[DVM] Failed to poll stale processing jobs:', e)
      }
    }
  }
}

// --- Cron: Poll DVM Requests (for service providers) ---

// Well-known test/garbage pubkeys that must never get user records.
const PUBKEY_BLACKLIST = new Set([
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // secp256k1 generator point (privkey=1, nak test key)
])

// Find or create a user record for a Nostr pubkey (shadow user for external pubkeys)
async function ensureUserForPubkey(db: Database, pubkey: string): Promise<string | null> {
  if (PUBKEY_BLACKLIST.has(pubkey)) return null

  const existing = await db.select({ id: users.id }).from(users)
    .where(eq(users.nostrPubkey, pubkey)).limit(1)
  if (existing.length > 0) return existing[0].id

  // Create shadow user for external pubkey
  const userId = generateId()
  const shortPub = pubkey.slice(0, 8)
  const username = `nostr_${shortPub}`
  // Avoid username collision
  const collision = await db.select({ id: users.id }).from(users)
    .where(eq(users.username, username)).limit(1)
  const finalUsername = collision.length > 0 ? `nostr_${pubkey.slice(0, 16)}` : username
  await db.insert(users).values({
    id: userId,
    username: finalUsername,
    displayName: null,
    nostrPubkey: pubkey,
    nostrSyncEnabled: 0,  // shadow users don't get public relay sync
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  console.log(`[DVM] Created shadow user ${finalUsername} for pubkey ${shortPub}...`)
  return userId
}

function isShadowUsername(username: string | null | undefined): boolean {
  return !!username && /^nostr_[0-9a-f]{8,16}$/i.test(username)
}

function usernameBaseFromProfileName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 20) || 'agent'
}

async function syncShadowUserProfile(
  db: Database,
  pubkey: string,
  profile: { name?: string | null; picture?: string | null; about?: string | null; lightningAddress?: string | null },
): Promise<void> {
  const existing = await db.select({
    id: users.id,
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    bio: users.bio,
    lightningAddress: users.lightningAddress,
  }).from(users).where(eq(users.nostrPubkey, pubkey)).limit(1)

  if (existing.length === 0) return

  const user = existing[0]
  const updates: Record<string, string | Date | null> = {}
  const name = profile.name?.trim() || null
  const picture = profile.picture?.trim() || null
  const about = profile.about?.trim() || null
  const lightningAddress = profile.lightningAddress?.trim() || null

  if (name && name !== user.displayName) updates.displayName = name
  if (picture && picture !== user.avatarUrl) updates.avatarUrl = picture
  if (about && about !== user.bio) updates.bio = about
  if (lightningAddress && lightningAddress !== user.lightningAddress) updates.lightningAddress = lightningAddress

  if (name && isShadowUsername(user.username)) {
    const nextBase = usernameBaseFromProfileName(name)
    if (nextBase !== user.username) {
      const nextUsername = await ensureUniqueUsername(db, nextBase)
      if (nextUsername !== user.username) updates.username = nextUsername
    }
  }

  if (Object.keys(updates).length === 0) return

  updates.updatedAt = new Date()
  await db.update(users).set(updates).where(eq(users.id, user.id))
  console.log(`[DVM] Upgraded shadow user ${user.id} from handler info: ${Object.keys(updates).join(', ')}`)
}

function hasMeaningfulJobPayload(params: {
  input: string | null
  inputType: string | null
  output: string | null
  params: string | null
  bidMsats: number | null
}): boolean {
  if (params.inputType === 'encrypted') return true
  if (params.input && params.input.trim()) return true
  if (params.output && params.output.trim()) return true
  if (params.params) {
    try {
      const parsed = JSON.parse(params.params) as Record<string, unknown>
      if (Object.keys(parsed).length > 0) return true
    } catch {
      return true
    }
  }
  if ((params.bidMsats || 0) > 0) return true
  return false
}

export async function pollDvmRequests(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  const ownRelay = env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  const allRelays = [...new Set([ownRelay, ...relayUrls])].filter(Boolean)
  if (allRelays.length === 0) return

  // Find active services (for provider matching)
  const activeServices = await db
    .select({
      id: dvmServices.id,
      userId: dvmServices.userId,
      kinds: dvmServices.kinds,
      totalZapReceived: dvmServices.totalZapReceived,
    })
    .from(dvmServices)
    .where(eq(dvmServices.active, 1))

  // Collect all registered kinds (for relay query filter)
  const allKinds = new Set<number>()
  for (const svc of activeServices) {
    try {
      const kinds = JSON.parse(svc.kinds) as number[]
      for (const k of kinds) allKinds.add(k)
    } catch {}
  }

  // Also poll common DVM kinds even without local providers (for indexing)
  // Official NIP-90 kinds + platform-specific kinds
  for (const k of [5001, 5002, 5050, 5100, 5200, 5250, 5300, 5301]) allKinds.add(k)

  if (allKinds.size === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_requests_last_poll'
  const sinceStr = await kv.get(sinceKey)
  let since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600

  // Cold-start backfill: when migrating to a fresh DB, replay a wider window so the
  // marketplace can repopulate without manual SQL imports.
  if (!sinceStr) {
    const existingCustomerJobs = await db.select({ id: dvmJobs.id })
      .from(dvmJobs)
      .where(eq(dvmJobs.role, 'customer'))
      .limit(1)
    if (existingCustomerJobs.length === 0) {
      since = Math.floor(Date.now() / 1000) - 30 * 86400
    }
  }

  try {
    const eventMap = new Map<string, NostrEvent>()
    for (const relayUrl of allRelays) {
      try {
        const { events } = await fetchEventsFromRelay(relayUrl, {
          kinds: Array.from(allKinds),
          since,
        })
        for (const event of events) {
          const existing = eventMap.get(event.id)
          if (!existing || event.created_at > existing.created_at) {
            eventMap.set(event.id, event)
          }
        }
      } catch (e) {
        console.warn(`[DVM] Failed to fetch requests from ${relayUrl}:`, e)
      }
    }
    const events = [...eventMap.values()].sort((a, b) => a.created_at - b.created_at)

    console.log(`[DVM] Fetched ${events.length} job requests since ${since}`)

    // Build user-to-kinds map for provider matching
    const userKindsMap = new Map<string, Set<number>>()
    for (const svc of activeServices) {
      try {
        const kinds = JSON.parse(svc.kinds) as number[]
        const existing = userKindsMap.get(svc.userId) || new Set()
        for (const k of kinds) existing.add(k)
        userKindsMap.set(svc.userId, existing)
      } catch {}
    }

    // Get provider pubkeys
    const userIds = Array.from(userKindsMap.keys())
    const providerUsers = userIds.length > 0
      ? await db.select({ id: users.id, nostrPubkey: users.nostrPubkey }).from(users).where(inArray(users.id, userIds))
      : []

    const userPubkeyMap = new Map(providerUsers.map(u => [u.id, u.nostrPubkey]))

    let maxCreatedAt = since

    // Build userId → totalZapReceived map for threshold check
    const userZapMap = new Map(activeServices.map(s => [s.userId, s.totalZapReceived || 0]))

    // Build report count map for flagged check
    const providerPubkeys = providerUsers.map(u => u.nostrPubkey).filter((pk): pk is string => !!pk)
    const reportCounts = new Map<string, number>()
    if (providerPubkeys.length > 0) {
      const rcRows = await db.select({
        targetPubkey: nostrReports.targetPubkey,
        count: sql<number>`COUNT(DISTINCT reporter_pubkey)`,
      }).from(nostrReports)
        .where(inArray(nostrReports.targetPubkey, providerPubkeys))
        .groupBy(nostrReports.targetPubkey)
      for (const row of rcRows) {
        reportCounts.set(row.targetPubkey, row.count)
      }
    }
    const REPORT_FLAG_THRESHOLD = 3

    for (const event of events) {
      if (!verifyEvent(event)) continue

      // Skip if we already have a customer record for this request event
      const existingCustomer = await db
        .select({ id: dvmJobs.id })
        .from(dvmJobs)
        .where(and(eq(dvmJobs.requestEventId, event.id), eq(dvmJobs.role, 'customer')))
        .limit(1)

      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at

      // Extract input from tags
      const isEncrypted = event.tags.some(t => t[0] === 'encrypted')
      const iTag = event.tags.find(t => t[0] === 'i')
      const input = isEncrypted ? null : (iTag?.[1] || event.content || '')
      const inputType = isEncrypted ? 'encrypted' : (iTag?.[2] || 'text')
      const outputTag = event.tags.find(t => t[0] === 'output')
      const bidTag = event.tags.find(t => t[0] === 'bid')
      const paramTags = event.tags.filter(t => t[0] === 'param')
      const params = paramTags.length > 0
        ? JSON.stringify(Object.fromEntries(paramTags.map(t => [t[1], t[2]])))
        : null
      const bidMsats = bidTag ? parseInt(bidTag[1]) : null

      // Ignore empty-shell NIP-90 requests that only carry routing/provider tags.
      // They pollute the public market but provide no actionable task content.
      if (!hasMeaningfulJobPayload({
        input,
        inputType,
        output: outputTag?.[1] || null,
        params,
        bidMsats,
      })) {
        continue
      }

      // 1. Index as customer record (any pubkey, local or external)
      if (existingCustomer.length === 0) {
        try {
          const customerUserId = await ensureUserForPubkey(db, event.pubkey)
          if (!customerUserId) continue
          const customerJobId = generateId()
          await db.insert(dvmJobs).values({
            id: customerJobId,
            userId: customerUserId,
            role: 'customer',
            kind: event.kind,
            status: 'open',
            input,
            inputType,
            output: outputTag?.[1] || null,
            bidMsats,
            customerPubkey: event.pubkey,
            requestEventId: event.id,
            params,
            createdAt: new Date(event.created_at * 1000),
            updatedAt: new Date(event.created_at * 1000),
          })
          console.log(`[DVM] Indexed customer job ${customerJobId} from ${event.pubkey.slice(0, 8)}... (kind ${event.kind})`)
        } catch (e) {
          console.error(`[DVM] Failed to index customer job:`, e)
        }
      }

      // 2. Skip provider matching if event is from a local provider (don't self-assign)
      const isOwnEvent = providerUsers.some(u => u.nostrPubkey === event.pubkey)
      if (isOwnEvent) continue

      // Skip if we already have provider records for this event
      const existingProvider = await db
        .select({ id: dvmJobs.id })
        .from(dvmJobs)
        .where(and(eq(dvmJobs.requestEventId, event.id), eq(dvmJobs.role, 'provider')))
        .limit(1)
      if (existingProvider.length > 0) continue

      // Parse min_zap_sats from param tags
      const minZapParam = paramTags.find(t => t[1] === 'min_zap_sats')
      const minZapSats = minZapParam ? parseInt(minZapParam[2]) : 0

      // 3. Create provider job for each matching local provider
      for (const [userId, kinds] of userKindsMap) {
        if (!kinds.has(event.kind)) continue

        // Check min_zap_sats threshold
        if (minZapSats > 0 && (userZapMap.get(userId) || 0) < minZapSats) {
          console.log(`[DVM] Skipping provider ${userId}: zap ${userZapMap.get(userId) || 0} < required ${minZapSats}`)
          continue
        }

        // Skip flagged providers
        const pubkey = userPubkeyMap.get(userId)
        if (pubkey && (reportCounts.get(pubkey) || 0) >= REPORT_FLAG_THRESHOLD) {
          console.log(`[DVM] Skipping flagged provider ${userId}`)
          continue
        }

        const jobId = generateId()
        await db.insert(dvmJobs).values({
          id: jobId,
          userId,
          role: 'provider',
          kind: event.kind,
          status: 'open',
          input,
          inputType,
          output: outputTag?.[1] || null,
          bidMsats,
          customerPubkey: event.pubkey,
          requestEventId: event.id,
          params,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        console.log(`[DVM] Created provider job ${jobId} for user ${userId} (kind ${event.kind})`)
      }
    }

    // Update KV timestamp
    if (maxCreatedAt > since) {
      await kv.put(sinceKey, String(maxCreatedAt + 1))
    }
  } catch (e) {
    console.error('[DVM] Failed to poll requests:', e)
  }
}

// --- Cron: Poll Zap Receipts for DVM Providers ---

export async function pollProviderZaps(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Find active services with their provider pubkeys
  const activeServices = await db
    .select({
      serviceId: dvmServices.id,
      userId: dvmServices.userId,
      totalZapReceived: dvmServices.totalZapReceived,
      nostrPubkey: users.nostrPubkey,
    })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  if (activeServices.length === 0) return

  // Filter to services with pubkeys
  const servicesWithPubkey = activeServices.filter(s => s.nostrPubkey)
  if (servicesWithPubkey.length === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_zap_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400 // Default: last 24h

  let maxCreatedAt = since

  // Collect unique pubkeys
  const pubkeys = [...new Set(servicesWithPubkey.map(s => s.nostrPubkey!))]

  try {
    // Query Kind 9735 (Zap Receipt) from all relays, dedup by event id
    const allEvents: Map<string, any> = new Map()
    for (const relayUrl of relayUrls) {
      try {
        const { events: relayEvents } = await fetchEventsFromRelay(relayUrl, {
          kinds: [9735],
          '#p': pubkeys,
          since,
        })
        for (const e of relayEvents) {
          if (!allEvents.has(e.id)) allEvents.set(e.id, e)
        }
        console.log(`[DVM] Fetched ${relayEvents.length} zap receipts from ${relayUrl}`)
      } catch (e) {
        console.warn(`[DVM] Failed to fetch zaps from ${relayUrl}:`, e)
      }
    }
    const events = [...allEvents.values()]

    console.log(`[DVM] Total ${events.length} unique zap receipts since ${since}`)

    // Accumulate zap amounts per pubkey
    const zapAmountByPubkey = new Map<string, number>()

    for (const event of events) {
      // Parse the description tag (contains serialized Kind 9734 JSON)
      const descTag = event.tags.find((t: string[]) => t[0] === 'description')
      if (!descTag || !descTag[1]) continue

      try {
        const zapRequest = JSON.parse(descTag[1])

        // Verify it's a Kind 9734 event
        if (zapRequest.kind !== 9734) continue

        // Find the target pubkey from the zap request's p tag
        const pTag = zapRequest.tags?.find((t: string[]) => t[0] === 'p')
        if (!pTag || !pTag[1]) continue
        const targetPubkey = pTag[1]

        // Only count if targeting one of our providers
        if (!pubkeys.includes(targetPubkey)) continue

        // Extract amount: try zap request amount tag first, fallback to bolt11
        let sats = 0
        const amountTag = zapRequest.tags?.find((t: string[]) => t[0] === 'amount')
        if (amountTag && amountTag[1]) {
          const msats = parseInt(amountTag[1])
          if (!isNaN(msats) && msats > 0) sats = Math.floor(msats / 1000)
        }
        if (sats === 0) {
          // Fallback: parse bolt11 invoice amount from receipt tags
          const bolt11Tag = event.tags.find((t: string[]) => t[0] === 'bolt11')
          if (bolt11Tag && bolt11Tag[1]) {
            const m = bolt11Tag[1].match(/^lnbc(\d+)([munp]?)/)
            if (m) {
              const num = parseInt(m[1])
              const unit = m[2] || ''
              if (unit === 'm') sats = num * 100000 // milli-BTC
              else if (unit === 'u') sats = num * 100 // micro-BTC
              else if (unit === 'n') sats = Math.floor(num / 10) // nano-BTC
              else if (unit === 'p') sats = Math.floor(num / 10000) // pico-BTC
              else sats = num * 100000000 // BTC
            }
          }
        }
        if (sats <= 0) continue
        const current = zapAmountByPubkey.get(targetPubkey) || 0
        zapAmountByPubkey.set(targetPubkey, current + sats)
      } catch {
        // Invalid description JSON, skip
      }

      if (event.created_at > maxCreatedAt) {
        maxCreatedAt = event.created_at
      }
    }

    // Update dvmServices with accumulated zap amounts
    for (const [pubkey, additionalSats] of zapAmountByPubkey) {
      const matchingServices = servicesWithPubkey.filter(s => s.nostrPubkey === pubkey)
      for (const svc of matchingServices) {
        const newTotal = (svc.totalZapReceived || 0) + additionalSats
        await db.update(dvmServices)
          .set({ totalZapReceived: newTotal, updatedAt: new Date() })
          .where(eq(dvmServices.id, svc.serviceId))
        console.log(`[DVM] Updated zap total for service ${svc.serviceId}: +${additionalSats} sats = ${newTotal} sats`)
      }
    }

    // Update KV timestamp
    if (maxCreatedAt > since) {
      await kv.put(sinceKey, String(maxCreatedAt + 1))
    }
  } catch (e) {
    console.error('[DVM] Failed to poll provider zaps:', e)
  }
}

// --- Cron: Poll Nostr Reports (Kind 1984) for DVM Providers ---

export async function pollNostrReports(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Find active services with their provider pubkeys
  const activeServices = await db
    .select({
      userId: dvmServices.userId,
      nostrPubkey: users.nostrPubkey,
    })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  if (activeServices.length === 0) return

  const servicesWithPubkey = activeServices.filter(s => s.nostrPubkey)
  if (servicesWithPubkey.length === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'nostr_reports_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400 // Default: last 24h

  const relayUrl = relayUrls[0]
  let maxCreatedAt = since

  const pubkeys = [...new Set(servicesWithPubkey.map(s => s.nostrPubkey!))]

  try {
    const { events } = await fetchEventsFromRelay(relayUrl, {
      kinds: [1984],
      '#p': pubkeys,
      since,
    })

    console.log(`[DVM] Fetched ${events.length} report events since ${since}`)

    for (const event of events) {
      if (!verifyEvent(event)) continue

      // Parse p tag for target pubkey and report type
      const pTag = event.tags.find((t: string[]) => t[0] === 'p')
      if (!pTag || !pTag[1]) continue
      const targetPubkey = pTag[1]
      const reportType = pTag[2] || 'other'

      // Only count if targeting one of our providers
      if (!pubkeys.includes(targetPubkey)) continue

      // Optional e tag for target event
      const eTag = event.tags.find((t: string[]) => t[0] === 'e')
      const targetEventId = eTag?.[1] || null

      // Dedup by nostrEventId
      const existing = await db.select({ id: nostrReports.id }).from(nostrReports)
        .where(eq(nostrReports.nostrEventId, event.id))
        .limit(1)
      if (existing.length > 0) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      await db.insert(nostrReports).values({
        id: generateId(),
        nostrEventId: event.id,
        reporterPubkey: event.pubkey,
        targetPubkey,
        targetEventId,
        reportType,
        content: event.content || null,
        createdAt: new Date(event.created_at * 1000),
      })
      console.log(`[DVM] Stored report ${event.id} against ${targetPubkey.slice(0, 8)}... (type: ${reportType})`)

      if (event.created_at > maxCreatedAt) {
        maxCreatedAt = event.created_at
      }
    }

    // Update KV timestamp
    if (maxCreatedAt > since) {
      await kv.put(sinceKey, String(maxCreatedAt + 1))
    }
  } catch (e) {
    console.error('[DVM] Failed to poll nostr reports:', e)
  }
}

// --- Cron: Poll External DVM Agents (Kind 31990) ---

export async function pollExternalDvms(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  // Add dedicated DVM relay
  const allRelays = [...new Set([...relayUrls, 'wss://relay.nostrdvm.com'])]
  if (allRelays.length === 0) return

  // KV-based incremental polling
  // Kind 31990 = parameterized replaceable events, may have old created_at.
  // First poll: no `since` filter to get all existing events.
  // Subsequent polls: use `since` for incremental updates.
  const kv = env.KV
  const sinceKey = 'external_dvm_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : undefined

  // Get local pubkeys — handle separately (upsert dvm_services instead of external_dvm)
  const localUsers = await db
    .select({ id: users.id, nostrPubkey: users.nostrPubkey })
    .from(users)
    .where(isNotNull(users.nostrPubkey))
  const localPubkeyToUserId = new Map(localUsers.map(u => [u.nostrPubkey!, u.id]))

  // Fetch Kind 31990 from all relays, dedup by event id
  const allEvents: Map<string, any> = new Map()
  for (const relayUrl of allRelays) {
    try {
      const filter: Record<string, any> = { kinds: [31990] }
      if (since) filter.since = since
      const { events: relayEvents } = await fetchEventsFromRelay(relayUrl, filter)
      for (const e of relayEvents) {
        if (!allEvents.has(e.id)) allEvents.set(e.id, e)
      }
      console.log(`[DVM] Fetched ${relayEvents.length} Kind 31990 events from ${relayUrl}`)
    } catch (e) {
      console.warn(`[DVM] Failed to fetch Kind 31990 from ${relayUrl}:`, e)
    }
  }
  const events = [...allEvents.values()]
  console.log(`[DVM] Total ${events.length} unique Kind 31990 events since ${since}`)

  let maxCreatedAt = since || 0
  let upsertCount = 0

  for (const event of events) {
    if (!verifyEvent(event)) continue

    // Extract d tag and k tag
    const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
    const kTag = event.tags.find((t: string[]) => t[0] === 'k')?.[1]
    if (!dTag || !kTag) {
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      continue
    }

    const kind = parseInt(kTag)
    if (isNaN(kind) || kind < 5000 || kind > 5999) {
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      continue
    }

    // Parse content JSON
    let name: string | null = null
    let picture: string | null = null
    let about: string | null = null
    let pricingMin: number | null = null
    let pricingMax: number | null = null
    let reputation: string | null = null
    let lightningAddress: string | null = null
    let skill: string | null = null

    try {
      const content = JSON.parse(event.content)
      name = content.name || null
      picture = content.picture || content.image || null
      about = content.about || null
      if (content.pricing) {
        // pricing can be { "5200": 10 } or { min: X, max: Y }
        if (typeof content.pricing === 'object') {
          const vals = Object.values(content.pricing).filter((v): v is number => typeof v === 'number')
          if (content.pricing.min != null) pricingMin = content.pricing.min
          else if (vals.length > 0) pricingMin = Math.min(...vals) * 1000 // sats to msats
          if (content.pricing.max != null) pricingMax = content.pricing.max
          else if (vals.length > 0) pricingMax = Math.max(...vals) * 1000
        }
      }
      if (content.reputation) {
        reputation = JSON.stringify(content.reputation)
      }
      if (content.payment?.lightning_address) {
        lightningAddress = content.payment.lightning_address
      } else if (content.lud16) {
        lightningAddress = content.lud16
      }
      if (content.skill) {
        skill = typeof content.skill === 'string' ? content.skill : JSON.stringify(content.skill)
      }
    } catch {
      // Content may not be JSON, use tags fallback
    }

    const now = new Date()

    // Local user → upsert dvm_services (auto-register service from relay)
    const localUserId = localPubkeyToUserId.get(event.pubkey)
    if (localUserId) {
      const existingSvc = await db
        .select({ id: dvmServices.id, eventId: dvmServices.eventId })
        .from(dvmServices)
        .where(eq(dvmServices.userId, localUserId))
        .limit(1)

      if (existingSvc.length > 0) {
        // Update existing service with latest kinds/pricing from Kind 31990
        await db.update(dvmServices)
          .set({
            kinds: JSON.stringify([kind]),
            pricingMin,
            pricingMax,
            eventId: event.id,
            active: 1,
            ...(skill ? { skill } : {}),
            updatedAt: now,
          })
          .where(eq(dvmServices.id, existingSvc[0].id))
        console.log(`[DVM] Updated local dvm_service for user ${localUserId} (kind ${kind})`)
      } else {
        // Create new service record
        await db.insert(dvmServices).values({
          id: generateId(),
          userId: localUserId,
          kinds: JSON.stringify([kind]),
          description: about,
          pricingMin,
          pricingMax,
          eventId: event.id,
          active: 1,
          directRequestEnabled: lightningAddress ? 1 : 0,
          ...(skill ? { skill } : {}),
          createdAt: now,
          updatedAt: now,
        })
        console.log(`[DVM] Created local dvm_service for user ${localUserId} (kind ${kind})`)
      }
      upsertCount++
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      continue
    }

    await syncShadowUserProfile(db, event.pubkey, {
      name,
      picture,
      about,
      lightningAddress,
    })

    // External user → upsert external_dvm
    const existing = await db
      .select({ id: externalDvms.id, eventCreatedAt: externalDvms.eventCreatedAt })
      .from(externalDvms)
      .where(and(eq(externalDvms.pubkey, event.pubkey), eq(externalDvms.dTag, dTag)))
      .limit(1)

    if (existing.length > 0) {
      if (event.created_at > existing[0].eventCreatedAt) {
        await db.update(externalDvms)
          .set({
            kind,
            name,
            picture,
            about,
            pricingMin,
            pricingMax,
            reputation,
            lightningAddress,
            eventId: event.id,
            eventCreatedAt: event.created_at,
            updatedAt: now,
          })
          .where(eq(externalDvms.id, existing[0].id))
        upsertCount++
      }
    } else {
      await db.insert(externalDvms).values({
        id: generateId(),
        pubkey: event.pubkey,
        dTag,
        kind,
        name,
        picture,
        about,
        pricingMin,
        pricingMax,
        reputation,
        lightningAddress,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        createdAt: now,
        updatedAt: now,
      })
      upsertCount++
    }

    if (event.created_at > maxCreatedAt) {
      maxCreatedAt = event.created_at
    }
  }

  console.log(`[DVM] Upserted ${upsertCount} external DVM records`)

  // Update KV timestamp
  if (maxCreatedAt > (since || 0)) {
    await kv.put(sinceKey, String(maxCreatedAt + 1))
  }
}

// --- Cron: Poll DVM Trust Declarations (Kind 30382) ---

export async function pollDvmTrust(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get all local provider pubkeys to filter #p
  const activeServices = await db
    .select({ nostrPubkey: users.nostrPubkey })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  const providerPubkeys = [...new Set(activeServices.map(s => s.nostrPubkey).filter((pk): pk is string => !!pk))]
  if (providerPubkeys.length === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_trust_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400

  let maxCreatedAt = since

  // Get local user pubkeys for matching trusters
  const localUsers = await db
    .select({ id: users.id, nostrPubkey: users.nostrPubkey })
    .from(users)
    .where(isNotNull(users.nostrPubkey))
  const pubkeyToUserId = new Map(localUsers.map(u => [u.nostrPubkey!, u.id]))

  for (const relayUrl of relayUrls) {
    try {
      const { events } = await fetchEventsFromRelay(relayUrl, {
        kinds: [30382],
        '#p': providerPubkeys,
        since,
      })

      console.log(`[DVM] Fetched ${events.length} Kind 30382 trust events from ${relayUrl}`)

      for (const event of events) {
        if (!verifyEvent(event)) continue

        // Only process if truster is a local user
        const trusterUserId = pubkeyToUserId.get(event.pubkey)
        if (!trusterUserId) {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        // Parse d tag (target pubkey) and assertion tag
        const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
        const assertionTag = event.tags.find((t: string[]) => t[0] === 'assertion')
        if (!dTag || !assertionTag || assertionTag[1] !== 'trusted_dvm' || assertionTag[2] !== '1') {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        const targetPubkey = dTag

        // Upsert: (userId, targetPubkey) unique
        const existing = await db.select({ id: dvmTrust.id }).from(dvmTrust)
          .where(and(eq(dvmTrust.userId, trusterUserId), eq(dvmTrust.targetPubkey, targetPubkey)))
          .limit(1)

        if (existing.length === 0) {
          await db.insert(dvmTrust).values({
            id: generateId(),
            userId: trusterUserId,
            targetPubkey,
            nostrEventId: event.id,
            createdAt: new Date(event.created_at * 1000),
          })
          console.log(`[DVM] Stored trust: ${event.pubkey.slice(0, 8)}... → ${targetPubkey.slice(0, 8)}...`)
        } else {
          // Update nostrEventId if missing
          await db.update(dvmTrust)
            .set({ nostrEventId: event.id })
            .where(eq(dvmTrust.id, existing[0].id))
        }

        if (event.created_at > maxCreatedAt) {
          maxCreatedAt = event.created_at
        }
      }
    } catch (e) {
      console.warn(`[DVM] Failed to fetch Kind 30382 from ${relayUrl}:`, e)
    }
  }

  // Update KV timestamp
  if (maxCreatedAt > since) {
    await kv.put(sinceKey, String(maxCreatedAt + 1))
  }
}

// --- Cron: Poll Heartbeats (Kind 30333) ---

export async function pollHeartbeats(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  const kv = env.KV
  const sinceKey = 'heartbeat_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600

  const relayUrl = relayUrls[0]
  let maxCreatedAt = since

  try {
    const { events } = await fetchEventsFromRelay(relayUrl, {
      kinds: [30333],
      since,
    })

    console.log(`[DVM] Fetched ${events.length} heartbeat events since ${since}`)

    // Get local user pubkeys for matching
    const localUsers = await db
      .select({ id: users.id, nostrPubkey: users.nostrPubkey })
      .from(users)
      .where(isNotNull(users.nostrPubkey))
    const pubkeyToUserId = new Map(localUsers.map(u => [u.nostrPubkey!, u.id]))

    for (const event of events) {
      if (!verifyEvent(event)) continue

      const userId = pubkeyToUserId.get(event.pubkey)
      if (!userId) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      const statusTag = event.tags.find((t: string[]) => t[0] === 'status')
      const capacityTag = event.tags.find((t: string[]) => t[0] === 'capacity')
      const kindsTag = event.tags.find((t: string[]) => t[0] === 'kinds')
      const priceTag = event.tags.find((t: string[]) => t[0] === 'price')
      const p2pStatsTag = event.tags.find((t: string[]) => t[0] === 'p2p_stats')

      const status = statusTag?.[1] || 'online'
      const capacity = capacityTag?.[1] ? parseInt(capacityTag[1]) : 0
      const kinds = kindsTag?.[1] ? JSON.stringify(kindsTag[1].split(',').map(Number)) : null
      let pricing: string | null = null
      if (priceTag?.[1]) {
        const priceObj: Record<string, number> = {}
        for (const pair of priceTag[1].split(',')) {
          const [k, v] = pair.split(':')
          if (k && v) priceObj[k] = parseInt(v)
        }
        pricing = JSON.stringify(priceObj)
      }
      let p2pStats: string | null = null
      if (p2pStatsTag?.[1]) {
        try { p2pStats = p2pStatsTag[1] } catch {}
      }

      const now = new Date()
      const existing = await db.select({ id: agentHeartbeats.id }).from(agentHeartbeats)
        .where(eq(agentHeartbeats.userId, userId))
        .limit(1)

      if (existing.length > 0) {
        await db.update(agentHeartbeats)
          .set({
            status,
            capacity,
            kinds,
            pricing,
            p2pStats: p2pStats,
            nostrEventId: event.id,
            lastSeenAt: event.created_at,
            updatedAt: now,
          })
          .where(eq(agentHeartbeats.id, existing[0].id))
      } else {
        await db.insert(agentHeartbeats).values({
          id: generateId(),
          userId,
          status,
          capacity,
          kinds,
          pricing,
          p2pStats: p2pStats,
          nostrEventId: event.id,
          lastSeenAt: event.created_at,
          createdAt: now,
          updatedAt: now,
        })
      }

      if (event.created_at > maxCreatedAt) {
        maxCreatedAt = event.created_at
      }
    }

    // Mark agents offline if not seen for 10 minutes
    const offlineThreshold = Math.floor(Date.now() / 1000) - 600
    await db.update(agentHeartbeats)
      .set({ status: 'offline', updatedAt: new Date() })
      .where(and(
        eq(agentHeartbeats.status, 'online'),
        sql`${agentHeartbeats.lastSeenAt} < ${offlineThreshold}`,
      ))

    if (maxCreatedAt > since) {
      await kv.put(sinceKey, String(maxCreatedAt + 1))
    }
  } catch (e) {
    console.error('[DVM] Failed to poll heartbeats:', e)
  }
}

// --- Cron: Poll Job Reviews (Kind 31117) ---

export async function pollJobReviews(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get provider pubkeys to filter #p
  const activeServices = await db
    .select({ nostrPubkey: users.nostrPubkey })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  const providerPubkeys = [...new Set(activeServices.map(s => s.nostrPubkey).filter((pk): pk is string => !!pk))]
  if (providerPubkeys.length === 0) return

  const kv = env.KV
  const sinceKey = 'dvm_review_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400

  const relayUrl = relayUrls[0]
  let maxCreatedAt = since

  // Get local user pubkeys for matching reviewers
  const localUsers = await db
    .select({ id: users.id, nostrPubkey: users.nostrPubkey })
    .from(users)
    .where(isNotNull(users.nostrPubkey))
  const pubkeyToUserId = new Map(localUsers.map(u => [u.nostrPubkey!, u.id]))

  try {
    const { events } = await fetchEventsFromRelay(relayUrl, {
      kinds: [31117],
      '#p': providerPubkeys,
      since,
    })

    console.log(`[DVM] Fetched ${events.length} Kind 31117 review events since ${since}`)

    for (const event of events) {
      if (!verifyEvent(event)) continue

      const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
      const pTag = event.tags.find((t: string[]) => t[0] === 'p')?.[1]
      const ratingTag = event.tags.find((t: string[]) => t[0] === 'rating')?.[1]
      const roleTag = event.tags.find((t: string[]) => t[0] === 'role')?.[1]
      const kindTag = event.tags.find((t: string[]) => t[0] === 'kind')?.[1]

      if (!dTag || !pTag || !ratingTag || !roleTag || !kindTag) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      const rating = parseInt(ratingTag)
      if (rating < 1 || rating > 5) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      // Match d tag (job event ID) to a local job
      const matchingJob = await db.select({ id: dvmJobs.id }).from(dvmJobs)
        .where(eq(dvmJobs.requestEventId, dTag))
        .limit(1)

      if (matchingJob.length === 0) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      // Find reviewer user
      let reviewerUserId = pubkeyToUserId.get(event.pubkey)
      if (!reviewerUserId) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      // Dedup: (job_id, reviewer_user_id)
      const existing = await db.select({ id: dvmReviews.id }).from(dvmReviews)
        .where(and(
          eq(dvmReviews.jobId, matchingJob[0].id),
          eq(dvmReviews.reviewerUserId, reviewerUserId),
        ))
        .limit(1)

      if (existing.length > 0) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      await db.insert(dvmReviews).values({
        id: generateId(),
        jobId: matchingJob[0].id,
        reviewerUserId,
        targetPubkey: pTag,
        rating,
        content: event.content || null,
        role: roleTag,
        jobKind: parseInt(kindTag),
        nostrEventId: event.id,
        createdAt: new Date(event.created_at * 1000),
      })

      // Update customer job status based on review rating:
      // rating >= 3 → completed (accepted/paid); rating <= 2 → rejected (explicitly rejected)
      const newStatus = rating !== null && rating <= 2 ? 'rejected' : 'completed'
      const customerJob = await db.select({ id: dvmJobs.id, status: dvmJobs.status })
        .from(dvmJobs)
        .where(and(eq(dvmJobs.requestEventId, dTag), eq(dvmJobs.role, 'customer')))
        .limit(1)
      if (customerJob.length > 0 && customerJob[0].status !== 'completed' && customerJob[0].status !== 'rejected') {
        await db.update(dvmJobs)
          .set({ status: newStatus, updatedAt: new Date() })
          .where(eq(dvmJobs.id, customerJob[0].id))
        console.log(`[DVM] Customer job ${customerJob[0].id} → ${newStatus} (review rating: ${rating})`)
      }

      console.log(`[DVM] Stored review for job ${matchingJob[0].id} (rating: ${rating})`)

      if (event.created_at > maxCreatedAt) {
        maxCreatedAt = event.created_at
      }
    }

    if (maxCreatedAt > since) {
      await kv.put(sinceKey, String(maxCreatedAt + 1))
    }
  } catch (e) {
    console.error('[DVM] Failed to poll job reviews:', e)
  }
}

export async function pollReputationEndorsements(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get all local provider pubkeys to filter #p
  const activeServices = await db
    .select({ nostrPubkey: users.nostrPubkey })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  const providerPubkeys = [...new Set(activeServices.map(s => s.nostrPubkey).filter((pk): pk is string => !!pk))]
  if (providerPubkeys.length === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_endorsement_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400

  let maxCreatedAt = since

  for (const relayUrl of relayUrls) {
    try {
      const { events } = await fetchEventsFromRelay(relayUrl, {
        kinds: [30311],
        '#p': providerPubkeys,
        since,
      })

      console.log(`[DVM] Fetched ${events.length} Kind 30311 endorsement events from ${relayUrl}`)

      for (const event of events) {
        if (!verifyEvent(event)) continue

        const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
        if (!dTag) {
          if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
          continue
        }

        const targetPubkey = dTag

        // Parse content JSON
        let rating: number | null = null
        let comment: string | null = null
        let context: string | null = null
        try {
          const parsed = JSON.parse(event.content)
          rating = typeof parsed.rating === 'number' ? parsed.rating : null
          comment = parsed.comment || null
          context = parsed.context ? JSON.stringify(parsed.context) : null
        } catch {
          // Content may not be valid JSON, try rating tag
          const ratingTag = event.tags.find((t: string[]) => t[0] === 'rating')?.[1]
          if (ratingTag) rating = parseInt(ratingTag)
        }

        const now = new Date()

        // Upsert: (endorser_pubkey, target_pubkey) unique — keep newest
        const existing = await db.select({ id: dvmEndorsements.id, eventCreatedAt: dvmEndorsements.eventCreatedAt })
          .from(dvmEndorsements)
          .where(and(eq(dvmEndorsements.endorserPubkey, event.pubkey), eq(dvmEndorsements.targetPubkey, targetPubkey)))
          .limit(1)

        if (existing.length === 0) {
          await db.insert(dvmEndorsements).values({
            id: generateId(),
            endorserPubkey: event.pubkey,
            targetPubkey,
            rating,
            comment,
            context,
            nostrEventId: event.id,
            eventCreatedAt: event.created_at,
            createdAt: now,
            updatedAt: now,
          })
          console.log(`[DVM] Stored endorsement: ${event.pubkey.slice(0, 8)}... → ${targetPubkey.slice(0, 8)}... (rating=${rating})`)
        } else if (event.created_at > existing[0].eventCreatedAt) {
          await db.update(dvmEndorsements)
            .set({ rating, comment, context, nostrEventId: event.id, eventCreatedAt: event.created_at, updatedAt: now })
            .where(eq(dvmEndorsements.id, existing[0].id))
        }

        if (event.created_at > maxCreatedAt) {
          maxCreatedAt = event.created_at
        }
      }
    } catch (e) {
      console.warn(`[DVM] Failed to fetch Kind 30311 from ${relayUrl}:`, e)
    }
  }

  // Update KV timestamp
  if (maxCreatedAt > since) {
    await kv.put(sinceKey, String(maxCreatedAt + 1))
  }
}

// --- Workflow: Advance to next step ---

export async function advanceWorkflow(db: Database, env: Bindings, completedJobId: string): Promise<void> {
  // Check if this job belongs to a workflow step
  const step = await db.select().from(dvmWorkflowSteps)
    .where(eq(dvmWorkflowSteps.jobId, completedJobId))
    .limit(1)

  if (step.length === 0) return

  const currentStep = step[0]

  // Get the completed job's result
  const job = await db.select({ result: dvmJobs.result }).from(dvmJobs)
    .where(eq(dvmJobs.id, completedJobId))
    .limit(1)

  if (job.length === 0) return

  const now = new Date()

  // Mark current step as completed with output
  await db.update(dvmWorkflowSteps).set({
    status: 'completed',
    output: job[0].result,
    updatedAt: now,
  }).where(eq(dvmWorkflowSteps.id, currentStep.id))

  // Get workflow
  const workflow = await db.select().from(dvmWorkflows)
    .where(eq(dvmWorkflows.id, currentStep.workflowId))
    .limit(1)

  if (workflow.length === 0) return

  const wf = workflow[0]
  const nextStepIndex = currentStep.stepIndex + 1

  // Update workflow current_step
  await db.update(dvmWorkflows).set({
    currentStep: nextStepIndex,
    updatedAt: now,
  }).where(eq(dvmWorkflows.id, wf.id))

  // Check if this was the last step
  if (nextStepIndex >= wf.totalSteps) {
    await db.update(dvmWorkflows).set({
      status: 'completed',
      updatedAt: now,
    }).where(eq(dvmWorkflows.id, wf.id))
    console.log(`[Workflow] ${wf.id} completed (all ${wf.totalSteps} steps done)`)
    return
  }

  // Get next step
  const nextStep = await db.select().from(dvmWorkflowSteps)
    .where(and(
      eq(dvmWorkflowSteps.workflowId, wf.id),
      eq(dvmWorkflowSteps.stepIndex, nextStepIndex),
    ))
    .limit(1)

  if (nextStep.length === 0) {
    await db.update(dvmWorkflows).set({ status: 'failed', updatedAt: now }).where(eq(dvmWorkflows.id, wf.id))
    return
  }

  // Create DVM job for next step, using previous step's output as input
  const nextInput = job[0].result || ''
  const wfUser = await db.select().from(users).where(eq(users.id, wf.userId)).limit(1)
  if (wfUser.length === 0 || !wfUser[0].nostrPrivEncrypted || !wfUser[0].nostrPrivIv) {
    await db.update(dvmWorkflows).set({ status: 'failed', updatedAt: now }).where(eq(dvmWorkflows.id, wf.id))
    return
  }

  const u = wfUser[0]
  const masterKey = env.NOSTR_MASTER_KEY
  if (!masterKey) {
    await db.update(dvmWorkflows).set({ status: 'failed', updatedAt: now }).where(eq(dvmWorkflows.id, wf.id))
    return
  }

  // Build job request event
  const jobEvent = await buildJobRequestEvent({
    privEncrypted: u.nostrPrivEncrypted!,
    iv: u.nostrPrivIv!,
    masterKey,
    kind: nextStep[0].kind,
    input: nextInput,
    inputType: 'text',
    bidMsats: wf.totalBidSats ? Math.floor((wf.totalBidSats * 1000) / wf.totalSteps) : undefined,
  })

  // Create customer job
  const jobId = generateId()
  await db.insert(dvmJobs).values({
    id: jobId,
    userId: wf.userId,
    role: 'customer',
    kind: nextStep[0].kind,
    status: 'open',
    input: nextInput,
    inputType: 'text',
    bidMsats: wf.totalBidSats ? Math.floor((wf.totalBidSats * 1000) / wf.totalSteps) : null,
    customerPubkey: u.nostrPubkey,
    requestEventId: jobEvent.id,
    eventId: jobEvent.id,
    createdAt: now,
    updatedAt: now,
  })

  // Link step to job
  await db.update(dvmWorkflowSteps).set({
    jobId,
    input: nextInput,
    status: 'running',
    updatedAt: now,
  }).where(eq(dvmWorkflowSteps.id, nextStep[0].id))

  // Update workflow status
  await db.update(dvmWorkflows).set({ status: 'running', updatedAt: now }).where(eq(dvmWorkflows.id, wf.id))

  console.log(`[Workflow] ${wf.id} advanced to step ${nextStepIndex} → job ${jobId}`)
}

// --- Relay Event Stream ---

const RELAY_EVENT_KINDS = [0, 1, 6, 7, 30023, 5001, 5002, 5050, 5100, 5200, 5250, 5300, 5301, 6001, 6002, 6050, 6100, 6200, 6250, 6300, 6301, 7000, 30333, 30311, 31117, 31990]

const KIND_LABELS: Record<number, string> = {
  0: 'profile',
  5001: 'summarization', 5002: 'translation', 5050: 'text generation',
  5100: 'image generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'content discovery', 5301: 'speech-to-text',
  6001: 'result: summary', 6002: 'result: translation', 6050: 'result: text',
  6100: 'result: image', 6200: 'result: image', 6250: 'result: video',
  6300: 'result: content', 6301: 'result: stt',
  7000: 'job feedback', 30023: 'article', 30333: 'heartbeat', 30311: 'endorsement', 31117: 'job review', 31990: 'handler info',
}

function extractContentPreview(event: NostrEvent): string | null {
  if (!event.content) return null
  // Encrypted events: never store content preview
  if (event.tags.some((t: string[]) => t[0] === 'encrypted')) return null
  // For Kind 0, parse JSON and extract name
  if (event.kind === 0) {
    try {
      const p = JSON.parse(event.content)
      return p.name ? `${p.name}${p.about ? ' — ' + p.about.slice(0, 100) : ''}` : event.content.slice(0, 200)
    } catch { return event.content.slice(0, 200) }
  }
  // For Kind 30023 (long-form article), extract title from tags or first line
  if (event.kind === 30023) {
    const titleTag = event.tags.find((t: string[]) => t[0] === 'title')?.[1]
    const summary = event.tags.find((t: string[]) => t[0] === 'summary')?.[1]
    if (titleTag) return titleTag + (summary ? ' — ' + summary.slice(0, 120) : '')
    return event.content.slice(0, 200)
  }
  // For Kind 30311, parse endorsement
  if (event.kind === 30311) {
    try {
      const p = JSON.parse(event.content)
      return `rating: ${p.rating || '?'}${p.comment ? ' — ' + p.comment.slice(0, 100) : ''}`
    } catch { return event.content.slice(0, 200) }
  }
  // For Kind 31990 (handler info), parse name/about
  if (event.kind === 31990) {
    try {
      const p = JSON.parse(event.content)
      const name = p.name || p.display_name || ''
      const about = p.about || ''
      if (name) return `${name}${about ? ' — ' + about.slice(0, 100) : ''}`
    } catch { /* not JSON */ }
    // Fallback: check d tag for handler name
    const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
    return dTag ? `handler: ${dTag.slice(0, 60)}` : null
  }
  // Kind 7 (reaction): content is the reaction emoji ("+", "🤙", etc.)
  if (event.kind === 7) return event.content || '+'
  // Kind 6 (repost): content is the reposted event JSON (we don't need it in preview)
  if (event.kind === 6) return null
  // For Kind 7000 (feedback), no useful content
  if (event.kind === 7000) return null
  // For Kind 30333 (heartbeat), no useful content
  if (event.kind === 30333) return null
  return event.content.slice(0, 5000)
}

function extractKeyTags(event: NostrEvent): string {
  const result: Record<string, string> = {}
  for (const tag of event.tags) {
    if (tag[0] === 'i') result.input = (tag[1] || '').slice(0, 100)
    if (tag[0] === 'p') result.p = tag[1] || ''
    if (tag[0] === 'e') result.e = tag[1] || ''
    if (tag[0] === 'status') result.status = tag[1] || ''
    if (tag[0] === 'd') result.d = tag[1] || ''
    if (tag[0] === 'amount') result.amount = tag[1] || ''
    if (tag[0] === 'rating') result.rating = tag[1] || ''
    if (tag[0] === 'title') result.title = (tag[1] || '').slice(0, 200)
    if (tag[0] === 'summary') result.summary = (tag[1] || '').slice(0, 300)
    if (tag[0] === 'encrypted') result.encrypted = '1'
  }
  return JSON.stringify(result)
}

export async function pollRelayEvents(env: Bindings, db: Database): Promise<void> {
  // Only poll the project's own relay — not public relays (nos.lol, relay.damus.io etc.)
  const relayUrl = env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  if (!relayUrl) return

  const kv = env.KV
  const sinceKey = 'relay_events_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600  // 1 hour lookback on first run

  let maxCreatedAt = since
  let inserted = 0

  try {
    const { events } = await fetchEventsFromRelay(relayUrl, {
      kinds: RELAY_EVENT_KINDS,
      since,
      limit: 200,
    })

    for (const event of events) {
      if (!verifyEvent(event)) continue
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at

      // Upsert (skip if exists)
      try {
        // For replaceable events (kind 30000-39999), delete old entries for same pubkey+kind+d-tag
        // to avoid duplicate entries while preserving different d-tags (e.g. endorsements for different agents)
        if (event.kind >= 30000 && event.kind < 40000) {
          const dTag = event.tags.find((t: string[]) => t[0] === 'd')?.[1] || ''
          await db.delete(relayEvents).where(
            and(eq(relayEvents.pubkey, event.pubkey), eq(relayEvents.kind, event.kind), sql`instr(${relayEvents.tags}, ${'"d":"' + dTag + '"'}) > 0`)
          )
        }
        const refEventId = event.tags.find((t: string[]) => t[0] === 'e')?.[1] || null
        await db.insert(relayEvents).values({
          id: generateId(),
          eventId: event.id,
          kind: event.kind,
          pubkey: event.pubkey,
          contentPreview: extractContentPreview(event),
          tags: extractKeyTags(event),
          refEventId,
          eventCreatedAt: event.created_at,
          createdAt: new Date(),
        }).onConflictDoNothing()
        inserted++
      } catch {
        // unique constraint — already indexed
      }
    }
  } catch (e: any) {
    console.warn(`[Relay] Event poll from ${relayUrl} failed: ${e.message}`)
  }

  if (maxCreatedAt > since) {
    await kv.put(sinceKey, String(maxCreatedAt))
  }
  if (inserted > 0) {
    console.log(`[Relay] Indexed ${inserted} events (since ${since})`)
  }
}

// --- Sync events from public relays for all registered 2020117.xyz users ---
// Users publish to public relays (damus, nos.lol, etc.) — pull their events into our DB
export async function pollPublicRelayForUsers(env: Bindings, db: Database): Promise<void> {
  const kv = env.KV
  const sinceKey = 'public_relay_user_sync_last'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400 // 24h lookback on first run

  // Get pubkeys for users with a 2020117.xyz NIP-05 identity
  const userRows = await db.select({ pubkey: users.nostrPubkey }).from(users).where(
    and(isNotNull(users.nostrPubkey), eq(users.nip05Enabled, 1))
  )
  const pubkeys = userRows.map(u => u.pubkey).filter(Boolean) as string[]
  if (pubkeys.length === 0) return

  const PUBLIC_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.nostr.band']
  const SYNC_KINDS = [1, 6, 7, 30023] // notes, reposts, reactions, articles

  let maxCreatedAt = since
  let inserted = 0

  for (const relayUrl of PUBLIC_RELAYS) {
    try {
      const { events } = await fetchEventsFromRelay(relayUrl, {
        kinds: SYNC_KINDS,
        authors: pubkeys,
        since,
        limit: 100,
      })

      for (const event of events) {
        if (!verifyEvent(event)) continue
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at

        try {
          // For replaceable events (kind 30000-39999), delete old entries for same pubkey+kind
          if (event.kind >= 30000 && event.kind < 40000) {
            await db.delete(relayEvents).where(
              and(eq(relayEvents.pubkey, event.pubkey), eq(relayEvents.kind, event.kind))
            )
          }
          await db.insert(relayEvents).values({
            id: generateId(),
            eventId: event.id,
            kind: event.kind,
            pubkey: event.pubkey,
            contentPreview: extractContentPreview(event),
            tags: extractKeyTags(event),
            eventCreatedAt: event.created_at,
            createdAt: new Date(),
          }).onConflictDoNothing()
          inserted++
        } catch { /* already indexed */ }
      }
    } catch (e: any) {
      console.warn(`[PublicSync] Poll from ${relayUrl} failed: ${e.message}`)
    }
  }

  if (maxCreatedAt > since) {
    await kv.put(sinceKey, String(maxCreatedAt))
  }
  if (inserted > 0) {
    console.log(`[PublicSync] Synced ${inserted} events for ${pubkeys.length} users (since ${since})`)
  }
}

// --- Index External Provider Jobs ---
// Part A: 6xxx result events in relay_event → create provider dvm_job records for external providers
// Part B: 30311 endorsements from relay → create P2P session dvm_job records

export async function indexExternalProviderJobs(env: Bindings, db: Database): Promise<void> {
  const kv = env.KV
  const relayUrl = env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'

  // --- Part A: 6xxx results → external provider dvm_jobs ---
  {
    const sinceKey = 'ext_provider_results_last_sync'
    const sinceTs = await kv.get(sinceKey)
    const since = sinceTs ? parseInt(sinceTs) : 0

    let maxTs = since
    let indexed = 0

    try {
      const resultRows = await db.select({
        eventId: relayEvents.eventId,
        kind: relayEvents.kind,
        pubkey: relayEvents.pubkey,
        tags: relayEvents.tags,
        contentPreview: relayEvents.contentPreview,
        eventCreatedAt: relayEvents.eventCreatedAt,
      }).from(relayEvents)
        .where(and(
          sql`kind >= 6000 AND kind <= 6999`,
          sql`event_created_at > ${since}`,
        ))
        .orderBy(relayEvents.eventCreatedAt)
        .limit(200)

      for (const re of resultRows) {
        if (re.eventCreatedAt > maxTs) maxTs = re.eventCreatedAt

        let tags: Record<string, string> = {}
        try { tags = JSON.parse(re.tags || '{}') } catch {}
        const requestEventId = tags.e
        if (!requestEventId) continue

        // Skip if provider dvm_job already exists for this result event
        const existing = await db.select({ id: dvmJobs.id })
          .from(dvmJobs)
          .where(and(eq(dvmJobs.resultEventId, re.eventId), eq(dvmJobs.role, 'provider')))
          .limit(1)
        if (existing.length > 0) continue

        // Look up customer job for context (input, customerPubkey)
        let customerJob = await db.select({
          input: dvmJobs.input,
          inputType: dvmJobs.inputType,
          customerPubkey: dvmJobs.customerPubkey,
        }).from(dvmJobs)
          .where(and(eq(dvmJobs.requestEventId, requestEventId), eq(dvmJobs.role, 'customer')))
          .limit(1)

        // If no customer record exists, fetch the request event from relay and backfill it
        if (customerJob.length === 0) {
          try {
            const { events: reqEvs } = await fetchEventsFromRelay(relayUrl, { ids: [requestEventId], limit: 1 })
            if (reqEvs.length > 0) {
              const reqEv = reqEvs[0]
              const custUserId = await ensureUserForPubkey(db, reqEv.pubkey)
              if (custUserId) {
                const iTag = reqEv.tags?.find((t: string[]) => t[0] === 'i')
                const bidTag = reqEv.tags?.find((t: string[]) => t[0] === 'bid')
                const cInput = iTag?.[1] || reqEv.content || null
                const cInputType = iTag?.[2] || 'text'
                await db.insert(dvmJobs).values({
                  id: generateId(),
                  userId: custUserId,
                  role: 'customer',
                  kind: reqEv.kind,
                  status: 'result_available',
                  input: cInput,
                  inputType: cInputType,
                  bidMsats: bidTag ? parseInt(bidTag[1]) : null,
                  customerPubkey: reqEv.pubkey,
                  requestEventId,
                  createdAt: new Date(reqEv.created_at * 1000),
                  updatedAt: new Date(),
                })
                customerJob = [{ input: cInput, inputType: cInputType, customerPubkey: reqEv.pubkey }]
                console.log(`[ExtProvider] Backfilled missing customer job for request ${requestEventId.slice(0, 8)}...`)
              }
            } else if (tags.p) {
              // Original request gone from relay — extract customer pubkey from result event's p tag
              const custUserId = await ensureUserForPubkey(db, tags.p)
              if (custUserId) {
                const requestKind = re.kind - 1000
                await db.insert(dvmJobs).values({
                  id: generateId(),
                  userId: custUserId,
                  role: 'customer',
                  kind: requestKind,
                  status: 'result_available',
                  input: null,
                  inputType: 'encrypted',
                  customerPubkey: tags.p,
                  requestEventId,
                  createdAt: new Date(re.eventCreatedAt * 1000),
                  updatedAt: new Date(),
                })
                customerJob = [{ input: null, inputType: 'encrypted', customerPubkey: tags.p }]
                console.log(`[ExtProvider] Backfilled customer job from p tag for request ${requestEventId.slice(0, 8)}...`)
              }
            }
          } catch (e) {
            console.error(`[ExtProvider] Failed to backfill customer job for ${requestEventId.slice(0, 8)}...:`, e)
          }
        }

        try {
          const userId = await ensureUserForPubkey(db, re.pubkey)
          if (!userId) continue
          const requestKind = re.kind - 1000  // 6100 → 5100
          const priceMsats = tags.amount ? parseInt(tags.amount) : null

          await db.insert(dvmJobs).values({
            id: generateId(),
            userId,
            role: 'provider',
            kind: requestKind,
            status: 'completed',
            input: customerJob[0]?.input || null,
            inputType: customerJob[0]?.inputType || 'text',
            result: re.contentPreview,
            customerPubkey: customerJob[0]?.customerPubkey || null,
            providerPubkey: re.pubkey,
            requestEventId,
            resultEventId: re.eventId,
            priceMsats,
            createdAt: new Date(re.eventCreatedAt * 1000),
            updatedAt: new Date(re.eventCreatedAt * 1000),
          })
          indexed++
          console.log(`[ExtProvider] Indexed provider job for ${re.pubkey.slice(0, 8)}... result ${re.eventId.slice(0, 8)}...`)
        } catch (e) {
          console.error(`[ExtProvider] Failed to index provider job for ${re.eventId.slice(0, 8)}...:`, e)
        }
      }
    } catch (e) {
      console.error('[ExtProvider] Part A failed:', e)
    }

    if (maxTs > since) await kv.put(sinceKey, String(maxTs))
    if (indexed > 0) console.log(`[ExtProvider] Indexed ${indexed} external provider jobs`)
  }

  // --- Part B: 30311 endorsements → P2P session dvm_jobs ---
  {
    const sinceKey = 'ext_p2p_sessions_last_sync'
    const sinceTs = await kv.get(sinceKey)
    const since = sinceTs ? parseInt(sinceTs) : Math.floor(Date.now() / 1000) - 86400 * 30  // 30 days lookback on first run

    let maxTs = since
    let indexed = 0

    try {
      const { events } = await fetchEventsFromRelay(relayUrl, {
        kinds: [30311],
        since,
      })

      for (const event of events) {
        if (!verifyEvent(event)) continue
        if (event.created_at > maxTs) maxTs = event.created_at

        // Only process endorsements with P2P session context
        let ctx: { session_duration_s?: number; total_sats?: number; kinds?: number[] } | null = null
        try {
          const parsed = JSON.parse(event.content)
          if (parsed.context?.session_duration_s !== undefined) {
            ctx = parsed.context
          }
        } catch {}
        if (!ctx) continue

        const customerPubkey = event.tags.find((t: string[]) => t[0] === 'd')?.[1]
        if (!customerPubkey) continue

        // Only create P2P records for providers that have actual DVM result activity (6xxx in relay_event)
        // This prevents test tools (e.g. nak) that only publish 30311 from entering the platform
        const hasDvmResults = await db.select({ id: relayEvents.id })
          .from(relayEvents)
          .where(and(eq(relayEvents.pubkey, event.pubkey), sql`kind >= 6000 AND kind <= 6999`))
          .limit(1)
        if (hasDvmResults.length === 0) continue

        // Dedup: use endorsement event ID as requestEventId (unique per session)
        const existing = await db.select({ id: dvmJobs.id })
          .from(dvmJobs)
          .where(eq(dvmJobs.requestEventId, event.id))
          .limit(1)
        if (existing.length > 0) continue

        try {
          const userId = await ensureUserForPubkey(db, event.pubkey)
          if (!userId) continue
          const kind = ctx.kinds?.[0] || 5000
          const params = JSON.stringify({
            channel: 'p2p',
            duration_s: ctx.session_duration_s || 0,
            total_sats: ctx.total_sats || 0,
          })

          await db.insert(dvmJobs).values({
            id: generateId(),
            userId,
            role: 'provider',
            kind,
            status: 'completed',
            customerPubkey,
            providerPubkey: event.pubkey,
            requestEventId: event.id,
            params,
            paymentMethod: 'p2p',
            createdAt: new Date(event.created_at * 1000),
            updatedAt: new Date(event.created_at * 1000),
          })
          indexed++
          console.log(`[ExtProvider] Indexed P2P session for ${event.pubkey.slice(0, 8)}... duration=${ctx.session_duration_s}s sats=${ctx.total_sats}`)
        } catch (e) {
          console.error(`[ExtProvider] Failed to index P2P session for ${event.id.slice(0, 8)}...:`, e)
        }
      }
    } catch (e) {
      console.error('[ExtProvider] Part B failed:', e)
    }

    if (maxTs > since) await kv.put(sinceKey, String(maxTs))
    if (indexed > 0) console.log(`[ExtProvider] Indexed ${indexed} P2P sessions`)
  }
}

// --- Cron: Poll Kind 30085 Reputation Attestations (NIP-XX) ---

export async function pollAttestations(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Filter by all registered user pubkeys as subjects
  const registeredUsers = await db
    .select({ nostrPubkey: users.nostrPubkey })
    .from(users)
    .where(isNotNull(users.nostrPubkey))

  const subjectPubkeys = [...new Set(registeredUsers.map(u => u.nostrPubkey).filter((pk): pk is string => !!pk))]
  if (subjectPubkeys.length === 0) return

  const kv = env.KV
  const sinceKey = 'dvm_attestation_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 86400 * 7
  const now = Math.floor(Date.now() / 1000)

  let maxCreatedAt = since
  let indexed = 0

  try {
    const { events } = await fetchEventsFromRelay(relayUrls[0], {
      kinds: [30085],
      '#p': subjectPubkeys,
      since,
    })

    console.log(`[DVM] Fetched ${events.length} Kind 30085 attestation events`)

    for (const event of events) {
      if (!verifyEvent(event)) continue

      // Skip self-attestations
      const pTag = event.tags.find((t: string[]) => t[0] === 'p')?.[1]
      if (!pTag || pTag === event.pubkey) continue

      // Parse and validate expiration tag
      const expirationTag = event.tags.find((t: string[]) => t[0] === 'expiration')?.[1]
      if (!expirationTag) continue  // expiration is required by spec
      const expiresAt = parseInt(expirationTag)
      if (isNaN(expiresAt) || expiresAt <= now) continue  // skip already-expired

      // Parse content JSON
      let content: { subject?: string; rating?: number; context?: string; confidence?: number; evidence?: string }
      try { content = JSON.parse(event.content) } catch { continue }

      const { subject, rating, context, confidence } = content
      if (!subject || subject !== pTag) continue  // subject must match p tag
      if (!context || typeof rating !== 'number' || rating < 1 || rating > 5) continue
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) continue

      // Upsert: one row per (attestor, subject, context) — keep latest
      const existing = await db.select({ id: dvmAttestations.id })
        .from(dvmAttestations)
        .where(and(
          eq(dvmAttestations.attestorPubkey, event.pubkey),
          eq(dvmAttestations.subjectPubkey, subject),
          eq(dvmAttestations.context, context),
        ))
        .limit(1)

      if (existing.length > 0) {
        await db.update(dvmAttestations)
          .set({
            id: event.id,
            rating,
            confidence,
            evidence: content.evidence || null,
            expiresAt,
            nostrCreatedAt: event.created_at,
            createdAt: new Date(),
          })
          .where(eq(dvmAttestations.id, existing[0].id))
      } else {
        await db.insert(dvmAttestations).values({
          id: event.id,
          attestorPubkey: event.pubkey,
          subjectPubkey: subject,
          context,
          rating,
          confidence,
          evidence: content.evidence || null,
          expiresAt,
          nostrCreatedAt: event.created_at,
          createdAt: new Date(),
        }).onConflictDoNothing()
      }

      indexed++
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
    }

    if (maxCreatedAt > since) await kv.put(sinceKey, String(maxCreatedAt + 1))
    if (indexed > 0) console.log(`[DVM] Indexed/updated ${indexed} Kind 30085 attestations`)
  } catch (e) {
    console.error('[DVM] Failed to poll attestations:', e)
  }
}
