import { eq, and, inArray, isNotNull } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { dvmJobs, dvmServices, users } from '../db/schema'
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

export async function buildHandlerInfoEvent(params: {
  privEncrypted: string
  iv: string
  masterKey: string
  kinds: number[]
  name: string
  about?: string
  pricingMin?: number
  pricingMax?: number
  userId: string
  reputation?: {
    jobs_completed: number
    jobs_rejected: number
    completion_rate: number
    avg_response_s: number | null
    total_earned_sats: number
    last_job_at: number | null
  }
}): Promise<NostrEvent> {
  const tags: string[][] = [
    ['d', `neogroup-dvm-${params.userId}`],
  ]
  for (const k of params.kinds) {
    tags.push(['k', String(k)])
  }

  const content = JSON.stringify({
    name: params.name,
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

  return buildSignedEvent({
    privEncrypted: params.privEncrypted,
    iv: params.iv,
    masterKey: params.masterKey,
    kind: 31990,
    content,
    tags,
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

      // Create provider job for each matching user
      for (const [userId, kinds] of userKindsMap) {
        if (!kinds.has(event.kind)) continue

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
