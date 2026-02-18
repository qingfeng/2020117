import { eq, and, sql, inArray } from 'drizzle-orm'
import { users, dvmServices, dvmJobs, dvmTrust, externalDvms, agentHeartbeats, dvmReviews } from '../db/schema'
import { pubkeyToNpub } from './nostr'
import type { Database } from '../db'

const DVM_KIND_LABELS: Record<number, string> = {
  5100: 'text generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'text-to-speech', 5301: 'speech-to-text', 5302: 'translation', 5303: 'summarization',
}

const REPORT_FLAG_THRESHOLD = 3

// Composite reputation score: WoT trust * 100 + log10(zap_sats) * 10 + completed_jobs * 5 + avg_rating * 20
function calcReputationScore(trustedBy: number, zapSats: number, completed: number, avgRating?: number): number {
  return trustedBy * 100 + (zapSats > 0 ? Math.floor(Math.log10(zapSats) * 10) : 0) + completed * 5 + Math.floor((avgRating || 0) * 20)
}

function buildReputationData(svc: {
  jobsCompleted: number | null
  jobsRejected: number | null
  totalEarnedMsats: number | null
  totalZapReceived: number | null
  avgResponseMs: number | null
  lastJobAt: Date | null
}, wotData?: { trusted_by: number; trusted_by_your_follows: number }, reviewData?: { avg_rating: number; review_count: number }) {
  const completed = svc.jobsCompleted || 0
  const rejected = svc.jobsRejected || 0
  const total = completed + rejected
  const trustedBy = wotData?.trusted_by || 0
  const zapSats = svc.totalZapReceived || 0
  const avgRating = reviewData?.avg_rating || 0
  return {
    score: calcReputationScore(trustedBy, zapSats, completed, avgRating),
    wot: wotData || { trusted_by: 0, trusted_by_your_follows: 0 },
    zaps: {
      total_received_sats: zapSats,
    },
    reviews: reviewData || { avg_rating: 0, review_count: 0 },
    platform: {
      jobs_completed: completed,
      jobs_rejected: rejected,
      completion_rate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
      avg_response_s: svc.avgResponseMs ? Math.round(svc.avgResponseMs / 1000) : null,
      total_earned_sats: svc.totalEarnedMsats ? Math.floor(svc.totalEarnedMsats / 1000) : 0,
      last_job_at: svc.lastJobAt ? Math.floor(svc.lastJobAt.getTime() / 1000) : null,
    },
  }
}

/**
 * Compute full agent list and write to KV cache.
 * Called from Cron every 60s. TTL 300s as safety net.
 */
export async function refreshAgentsCache(env: { KV: KVNamespace }, db: Database) {
  // --- Local agents ---
  const localRows = await db.select({
    username: users.username,
    displayName: users.displayName,
    avatarUrl: users.avatarUrl,
    bio: users.bio,
    nostrPubkey: users.nostrPubkey,
    userId: dvmServices.userId,
    kinds: dvmServices.kinds,
    description: dvmServices.description,
    totalZapReceived: dvmServices.totalZapReceived,
    directRequestEnabled: dvmServices.directRequestEnabled,
    jobsCompleted: dvmServices.jobsCompleted,
    jobsRejected: dvmServices.jobsRejected,
    totalEarnedMsats: dvmServices.totalEarnedMsats,
    lastJobAt: dvmServices.lastJobAt,
    completedJobsCount: sql<number>`(SELECT COUNT(*) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'provider' AND dvm_job.status = 'completed')`,
    earnedMsats: sql<number>`(SELECT COALESCE(SUM(dvm_job.bid_msats), 0) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'provider' AND dvm_job.status = 'completed')`,
    lastSeenAt: sql<number>`(SELECT MAX(dvm_job.updated_at) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id)`,
    avgResponseMs: dvmServices.avgResponseMs,
    reportCount: sql<number>`(SELECT COUNT(DISTINCT reporter_pubkey) FROM nostr_report WHERE target_pubkey = "user".nostr_pubkey)`,
    trustedBy: sql<number>`(SELECT COUNT(*) FROM dvm_trust WHERE dvm_trust.target_pubkey = "user".nostr_pubkey)`,
    avgRating: sql<number>`(SELECT COALESCE(AVG(dvm_review.rating), 0) FROM dvm_review WHERE dvm_review.target_pubkey = "user".nostr_pubkey)`,
    reviewCount: sql<number>`(SELECT COUNT(*) FROM dvm_review WHERE dvm_review.target_pubkey = "user".nostr_pubkey)`,
    onlineStatus: sql<string>`(SELECT ah.status FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    heartbeatCapacity: sql<number>`(SELECT ah.capacity FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    heartbeatPricing: sql<string>`(SELECT ah.pricing FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
  })
    .from(dvmServices)
    .innerJoin(users, eq(dvmServices.userId, users.id))
    .where(eq(dvmServices.active, 1))

  const localAgents = localRows.map(row => {
    const kinds: number[] = JSON.parse(row.kinds)
    const kindLabels = kinds.map(k => DVM_KIND_LABELS[k] || `kind ${k}`)
    return {
      source: 'local' as const,
      username: row.username,
      display_name: row.displayName,
      avatar_url: row.avatarUrl,
      bio: row.bio,
      nostr_pubkey: row.nostrPubkey,
      npub: row.nostrPubkey ? pubkeyToNpub(row.nostrPubkey) : null,
      services: [{ kinds, kind_labels: kindLabels, description: row.description }],
      completed_jobs_count: row.completedJobsCount || 0,
      earned_sats: Math.floor((row.earnedMsats || 0) / 1000),
      last_seen_at: row.lastSeenAt || null,
      avg_response_time_s: row.avgResponseMs ? Math.round(row.avgResponseMs / 1000) : null,
      total_zap_received_sats: row.totalZapReceived || 0,
      direct_request_enabled: !!row.directRequestEnabled,
      report_count: row.reportCount || 0,
      flagged: (row.reportCount || 0) >= REPORT_FLAG_THRESHOLD,
      online_status: row.onlineStatus || 'unknown',
      capacity: row.heartbeatCapacity || 0,
      pricing: row.heartbeatPricing ? JSON.parse(row.heartbeatPricing) : null,
      reputation: buildReputationData(row, {
        trusted_by: row.trustedBy || 0,
        trusted_by_your_follows: 0,
      }, {
        avg_rating: row.avgRating ? Math.round(row.avgRating * 100) / 100 : 0,
        review_count: row.reviewCount || 0,
      }),
      _sort_ts: row.lastSeenAt || 0,
    }
  })

  // --- External agents (from external_dvm table) ---
  const extRows = await db.select().from(externalDvms)
  const byPubkey = new Map<string, typeof extRows>()
  for (const row of extRows) {
    const existing = byPubkey.get(row.pubkey) || []
    existing.push(row)
    byPubkey.set(row.pubkey, existing)
  }

  // Batch fetch trust counts (D1 limit: 100 params)
  const extPubkeys = [...byPubkey.keys()]
  const extTrustCounts = new Map<string, number>()
  const BATCH = 80
  for (let i = 0; i < extPubkeys.length; i += BATCH) {
    const batch = extPubkeys.slice(i, i + BATCH)
    const trustRows = await db.select({
      targetPubkey: dvmTrust.targetPubkey,
      count: sql<number>`COUNT(*)`,
    }).from(dvmTrust)
      .where(inArray(dvmTrust.targetPubkey, batch))
      .groupBy(dvmTrust.targetPubkey)
    for (const row of trustRows) {
      extTrustCounts.set(row.targetPubkey, row.count)
    }
  }

  const externalAgents = []
  for (const [pubkey, rows] of byPubkey) {
    const kinds = rows.map(r => r.kind)
    const kindLabels = kinds.map(k => DVM_KIND_LABELS[k] || `kind ${k}`)
    const latest = rows.reduce((a, b) => a.eventCreatedAt > b.eventCreatedAt ? a : b)
    externalAgents.push({
      source: 'nostr' as const,
      username: null,
      display_name: latest.name || `${pubkey.slice(0, 12)}...`,
      avatar_url: latest.picture || null,
      bio: latest.about || null,
      nostr_pubkey: pubkey,
      npub: pubkeyToNpub(pubkey),
      services: [{ kinds, kind_labels: kindLabels, description: latest.about }],
      completed_jobs_count: 0,
      earned_sats: 0,
      last_seen_at: latest.eventCreatedAt,
      avg_response_time_s: null,
      total_zap_received_sats: 0,
      direct_request_enabled: false,
      report_count: 0,
      flagged: false,
      reputation: buildReputationData({
        jobsCompleted: 0, jobsRejected: 0, totalEarnedMsats: 0,
        totalZapReceived: 0, avgResponseMs: null, lastJobAt: null,
      }, { trusted_by: extTrustCounts.get(pubkey) || 0, trusted_by_your_follows: 0 }),
      _sort_ts: latest.eventCreatedAt,
    })
  }

  // Sort: local first (by last_seen desc), then external (by last_seen desc)
  localAgents.sort((a, b) => (b._sort_ts || 0) - (a._sort_ts || 0))
  externalAgents.sort((a, b) => (b._sort_ts || 0) - (a._sort_ts || 0))

  const stripSort = (arr: any[]) => arr.map(({ _sort_ts, ...rest }) => rest)
  const allClean = stripSort([...localAgents, ...externalAgents])
  const localClean = stripSort(localAgents)
  const nostrClean = stripSort(externalAgents)

  // Write all three source variants to KV (TTL 300s safety net; Cron refreshes every 60s)
  await Promise.all([
    env.KV.put('agents_cache_all', JSON.stringify(allClean), { expirationTtl: 300 }),
    env.KV.put('agents_cache_local', JSON.stringify(localClean), { expirationTtl: 300 }),
    env.KV.put('agents_cache_nostr', JSON.stringify(nostrClean), { expirationTtl: 300 }),
  ])

  console.log(`[Cache] Agents refreshed: ${localClean.length} local, ${nostrClean.length} external`)
}

/**
 * Compute global stats and write to KV cache.
 * Called from Cron every 60s. TTL 300s as safety net.
 */
export async function refreshStatsCache(env: { KV: KVNamespace }, db: Database) {
  const [volumeResult, completedResult, zapResult, activeResult] = await Promise.all([
    db.select({ total: sql<number>`COALESCE(SUM(bid_msats), 0)` })
      .from(dvmJobs)
      .where(and(eq(dvmJobs.role, 'customer'), eq(dvmJobs.status, 'completed'))),
    db.select({ count: sql<number>`COUNT(*)` })
      .from(dvmJobs)
      .where(and(eq(dvmJobs.role, 'customer'), eq(dvmJobs.status, 'completed'))),
    db.select({ total: sql<number>`COALESCE(SUM(total_zap_received), 0)` })
      .from(dvmServices),
    db.select({ count: sql<number>`COUNT(DISTINCT user_id)` })
      .from(dvmJobs)
      .where(sql`${dvmJobs.updatedAt} > ${Math.floor(Date.now() / 1000) - 86400}`),
  ])

  const result = {
    total_volume_sats: Math.floor((volumeResult[0]?.total || 0) / 1000),
    total_jobs_completed: completedResult[0]?.count || 0,
    total_zaps_sats: zapResult[0]?.total || 0,
    active_users_24h: activeResult[0]?.count || 0,
  }

  await env.KV.put('stats_cache', JSON.stringify(result), { expirationTtl: 300 })
  console.log(`[Cache] Stats refreshed: ${JSON.stringify(result)}`)
}
