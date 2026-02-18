import { eq, and, inArray, isNotNull, sql } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { dvmJobs, dvmServices, dvmTrust, users, nostrReports, externalDvms, agentHeartbeats, dvmReviews, dvmWorkflows, dvmWorkflowSteps } from '../db/schema'
import { type NostrEvent, buildSignedEvent, verifyEvent } from './nostr'
import { fetchEventsFromRelay } from './nostr-community'
import { generateId } from '../lib/utils'

// --- Event Builders ---

export async function buildJobRequestEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kind: number
  input: string
  inputType: string
  output?: string
  bidMsats?: number
  extraParams?: Record<string, string>
  relays?: string[]
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
  ]
  if (params.output) {
    tags.push(['output', params.output])
  }
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }
  if (params.relays && params.relays.length > 0) {
    tags.push(['relays', ...params.relays])
  }
  if (params.extraParams) {
    for (const [key, value] of Object.entries(params.extraParams)) {
      tags.push(['param', key, value])
    }
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: params.kind,
    content: '',
    tags,
  })
}

export async function buildJobResultEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  requestKind: number
  requestEventId: string
  customerPubkey: string
  content: string
  amountMsats?: number
  bolt11?: string
}): Promise<NostrEvent> {
  const resultKind = params.requestKind + 1000
  const tags: string[][] = [
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
  ]
  if (params.amountMsats) {
    const amountTag = ['amount', String(params.amountMsats)]
    if (params.bolt11) amountTag.push(params.bolt11)
    tags.push(amountTag)
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: resultKind,
    content: params.content,
    tags,
  })
}

export async function buildJobFeedbackEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  requestEventId: string
  customerPubkey: string
  status: 'processing' | 'success' | 'error' | 'payment-required'
  content?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['status', params.status],
    ['e', params.requestEventId],
    ['p', params.customerPubkey],
  ]

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 7000,
    content: params.content || '',
    tags,
  })
}

export async function buildHandlerInfoEvents(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kinds: number[]
  name: string
  picture?: string
  about?: string
  pricingMin?: number
  pricingMax?: number
  userId: string
  reputation?: Record<string, unknown>
}): Promise<NostrEvent[]> {
  const content = JSON.stringify({
    name: params.name,
    ...(params.picture ? { picture: params.picture } : {}),
    about: params.about || '',
    ...(params.pricingMin || params.pricingMax ? {
      pricing: {
        unit: 'msats',
        ...(params.pricingMin ? { min: params.pricingMin } : {}),
        ...(params.pricingMax ? { max: params.pricingMax } : {}),
      },
    } : {}),
    ...(params.reputation ? { reputation: params.reputation } : {}),
  })

  // One event per kind (matches NIP-89 convention used by other DVMs)
  const events: NostrEvent[] = []
  for (const k of params.kinds) {
    const event = await buildSignedEvent({
      privEncrypted: params.privEncrypted,
      iv: params.iv,
      masterKey: params.masterKey,
      kind: 31990,
      content,
      tags: [
        ['d', `neogroup-dvm-${params.userId}-${k}`],
        ['k', String(k)],
      ],
    })
    events.push(event)
  }
  return events
}

// --- Kind 30382: DVM Trust Declaration (NIP-85 Trusted Assertions) ---

export async function buildDvmTrustEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  targetPubkey: string
}): Promise<NostrEvent> {
  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 30382,
    content: '',
    tags: [
      ['d', params.targetPubkey],
      ['p', params.targetPubkey],
      ['assertion', 'trusted_dvm', '1'],
    ],
  })
}

// --- Cron: Poll DVM Results (for customers) ---

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
    })
    .from(dvmJobs)
    .where(and(
      eq(dvmJobs.role, 'customer'),
      inArray(dvmJobs.status, ['open', 'processing']),
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

  // Poll for Job Results (Kind 6000-6999) and Feedback (Kind 7000)
  // We need to query for events that reference our request event IDs
  const BATCH_SIZE = 50
  let maxCreatedAt = since

  for (let i = 0; i < requestEventIds.length; i += BATCH_SIZE) {
    const batch = requestEventIds.slice(i, i + BATCH_SIZE)

    try {
      // Query Kind 6000-6999 results
      const resultRelay = await fetchEventsFromRelay(relayUrl, {
        kinds: Array.from({ length: 1000 }, (_, k) => k + 6000),
        '#e': batch,
        since,
      })

      // Query Kind 7000 feedback
      const feedbackRelay = await fetchEventsFromRelay(relayUrl, {
        kinds: [7000],
        '#e': batch,
        since,
      })

      const allEvents = [...resultRelay.events, ...feedbackRelay.events]

      for (const event of allEvents) {
        if (!verifyEvent(event)) continue

        // Find which request this responds to
        const eTag = event.tags.find(t => t[0] === 'e')
        if (!eTag) continue
        const refEventId = eTag[1]

        const job = activeJobs.find(j => j.requestEventId === refEventId)
        if (!job) continue

        if (event.kind === 7000) {
          // Feedback event
          const statusTag = event.tags.find(t => t[0] === 'status')
          const feedbackStatus = statusTag?.[1]

          if (feedbackStatus === 'processing' && job.status === 'open') {
            await db.update(dvmJobs)
              .set({ status: 'processing', providerPubkey: event.pubkey, updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[DVM] Job ${job.id} → processing (provider: ${event.pubkey.slice(0, 8)}...)`)
          } else if (feedbackStatus === 'error') {
            await db.update(dvmJobs)
              .set({ status: 'error', result: event.content || 'Error', updatedAt: new Date() })
              .where(eq(dvmJobs.id, job.id))
            console.log(`[DVM] Job ${job.id} → error`)
          }
        } else if (event.kind >= 6000 && event.kind <= 6999) {
          // Result event — extract bolt11 from amount tag
          const amountTag = event.tags.find(t => t[0] === 'amount')
          const bolt11 = amountTag?.[2] || null
          const priceMsats = amountTag?.[1] ? parseInt(amountTag[1]) : null

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
          console.log(`[DVM] Job ${job.id} → result_available (provider: ${event.pubkey.slice(0, 8)}...${bolt11 ? ', has bolt11' : ''})`)

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
}

// --- Cron: Poll DVM Requests (for service providers) ---

export async function pollDvmRequests(env: Bindings, db: Database): Promise<void> {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Find active services
  const activeServices = await db
    .select({
      id: dvmServices.id,
      userId: dvmServices.userId,
      kinds: dvmServices.kinds,
      totalZapReceived: dvmServices.totalZapReceived,
    })
    .from(dvmServices)
    .where(eq(dvmServices.active, 1))

  if (activeServices.length === 0) return

  // Collect all registered kinds
  const allKinds = new Set<number>()
  for (const svc of activeServices) {
    try {
      const kinds = JSON.parse(svc.kinds) as number[]
      for (const k of kinds) allKinds.add(k)
    } catch {}
  }

  if (allKinds.size === 0) return

  // KV-based incremental polling
  const kv = env.KV
  const sinceKey = 'dvm_requests_last_poll'
  const sinceStr = await kv.get(sinceKey)
  const since = sinceStr ? parseInt(sinceStr) : Math.floor(Date.now() / 1000) - 3600

  const relayUrl = relayUrls[0]

  try {
    const { events } = await fetchEventsFromRelay(relayUrl, {
      kinds: Array.from(allKinds),
      since,
    })

    console.log(`[DVM] Fetched ${events.length} job requests since ${since}`)

    // Build user-to-kinds map for matching
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
    const providerUsers = await db
      .select({ id: users.id, nostrPubkey: users.nostrPubkey })
      .from(users)
      .where(inArray(users.id, userIds))

    const userPubkeyMap = new Map(providerUsers.map(u => [u.id, u.nostrPubkey]))

    let maxCreatedAt = since

    // Build userId → totalZapReceived map for threshold check (static across events)
    const userZapMap = new Map(activeServices.map(s => [s.userId, s.totalZapReceived || 0]))

    // Build report count map for flagged check (static across events)
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

      // Skip if we already have this request
      const existing = await db
        .select({ id: dvmJobs.id })
        .from(dvmJobs)
        .where(eq(dvmJobs.requestEventId, event.id))
        .limit(1)
      if (existing.length > 0) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      // Skip if this event is from one of our own providers (don't accept own requests)
      const isOwnEvent = providerUsers.some(u => u.nostrPubkey === event.pubkey)
      if (isOwnEvent) {
        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
        continue
      }

      // Extract input from tags
      const iTag = event.tags.find(t => t[0] === 'i')
      const input = iTag?.[1] || event.content || ''
      const inputType = iTag?.[2] || 'text'
      const outputTag = event.tags.find(t => t[0] === 'output')
      const bidTag = event.tags.find(t => t[0] === 'bid')
      const paramTags = event.tags.filter(t => t[0] === 'param')
      const params = paramTags.length > 0
        ? JSON.stringify(Object.fromEntries(paramTags.map(t => [t[1], t[2]])))
        : null

      // Parse min_zap_sats from param tags
      const minZapParam = paramTags.find(t => t[1] === 'min_zap_sats')
      const minZapSats = minZapParam ? parseInt(minZapParam[2]) : 0

      // Create provider job for each matching user
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
          bidMsats: bidTag ? parseInt(bidTag[1]) : null,
          customerPubkey: event.pubkey,
          requestEventId: event.id,
          params,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        console.log(`[DVM] Created provider job ${jobId} for user ${userId} (kind ${event.kind})`)
      }

      if (event.created_at > maxCreatedAt) {
        maxCreatedAt = event.created_at
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

  // Get local pubkeys to exclude
  const localUsers = await db
    .select({ nostrPubkey: users.nostrPubkey })
    .from(users)
    .where(isNotNull(users.nostrPubkey))
  const localPubkeys = new Set(localUsers.map(u => u.nostrPubkey!))

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

    // Skip local pubkeys
    if (localPubkeys.has(event.pubkey)) {
      if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      continue
    }

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

    try {
      const content = JSON.parse(event.content)
      name = content.name || null
      picture = content.picture || content.image || null
      about = content.about || null
      if (content.pricing) {
        pricingMin = content.pricing.min || null
        pricingMax = content.pricing.max || null
      }
      if (content.reputation) {
        reputation = JSON.stringify(content.reputation)
      }
    } catch {
      // Content may not be JSON, use tags fallback
    }

    // Upsert by (pubkey, d_tag): only update if new event is newer
    const existing = await db
      .select({ id: externalDvms.id, eventCreatedAt: externalDvms.eventCreatedAt })
      .from(externalDvms)
      .where(and(eq(externalDvms.pubkey, event.pubkey), eq(externalDvms.dTag, dTag)))
      .limit(1)

    const now = new Date()

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

// --- Kind 30333: Agent Heartbeat ---

export async function buildHeartbeatEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  pubkey: string
  capacity?: number
  kinds?: number[]
  pricing?: Record<string, number>
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.pubkey],
    ['status', 'online'],
  ]
  if (params.capacity !== undefined) {
    tags.push(['capacity', String(params.capacity)])
  }
  if (params.kinds && params.kinds.length > 0) {
    tags.push(['kinds', params.kinds.join(',')])
  }
  if (params.pricing && Object.keys(params.pricing).length > 0) {
    const priceStr = Object.entries(params.pricing).map(([k, v]) => `${k}:${v}`).join(',')
    tags.push(['price', priceStr])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 30333,
    content: '',
    tags,
  })
}

// --- Kind 31117: Job Review ---

export async function buildJobReviewEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  jobEventId: string
  targetPubkey: string
  rating: number
  role: string
  jobKind: number
  content?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', params.jobEventId],
    ['p', params.targetPubkey],
    ['rating', String(params.rating)],
    ['role', params.role],
    ['kind', String(params.jobKind)],
  ]

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 31117,
    content: params.content || '',
    tags,
  })
}

// --- Kind 21117: Escrow Result ---

export async function buildEscrowResultEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  customerPubkey: string
  jobEventId: string
  encryptedPayload: string
  hash: string
  preview?: string
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['p', params.customerPubkey],
    ['e', params.jobEventId],
    ['hash', params.hash],
  ]
  if (params.preview) {
    tags.push(['preview', params.preview])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 21117,
    content: params.encryptedPayload,
    tags,
  })
}

// --- Kind 5117: Workflow Chain ---

export async function buildWorkflowEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  description: string
  input: string
  inputType: string
  steps: { kind: number; provider?: string; description?: string }[]
  bidMsats?: number
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
  ]
  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i]
    tags.push(['step', String(i), String(step.kind), step.provider || '', step.description || ''])
  }
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 5117,
    content: params.description,
    tags,
  })
}

// --- Kind 5118: Agent Swarm ---

export async function buildSwarmEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  content: string
  input: string
  inputType: string
  maxProviders: number
  judge?: string
  bidMsats?: number
  kind: number
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['i', params.input, params.inputType],
    ['swarm', String(params.maxProviders)],
    ['judge', params.judge || 'customer'],
  ]
  if (params.bidMsats) {
    tags.push(['bid', String(params.bidMsats)])
  }

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: params.kind,
    content: params.content,
    tags,
  })
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

  // Publish to relay
  if (env.NOSTR_QUEUE) {
    env.NOSTR_QUEUE.send({ events: [jobEvent] })
  }

  console.log(`[Workflow] ${wf.id} advanced to step ${nextStepIndex} → job ${jobId}`)
}
