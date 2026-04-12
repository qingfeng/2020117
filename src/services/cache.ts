import { eq, and, sql, isNotNull, inArray } from 'drizzle-orm'
import { users, dvmServices, dvmJobs, dvmTrust, externalDvms, agentHeartbeats, dvmReviews, relayEvents } from '../db/schema'
import { pubkeyToNpub } from './nostr'
import type { Database } from '../db'

const DVM_KIND_LABELS: Record<number, string> = {
  5001: 'summarization', 5002: 'translation', 5050: 'text generation',
  5100: 'image generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'content discovery', 5301: 'speech-to-text',
}

const REPORT_FLAG_THRESHOLD = 3

// D1 may return Date objects for integer timestamp columns via raw SQL — normalize to Unix seconds
function toUnixSecs(v: unknown): number {
  if (v instanceof Date) return Math.floor(v.getTime() / 1000)
  if (typeof v === 'string') { const ms = new Date(v).getTime(); return isNaN(ms) ? 0 : Math.floor(ms / 1000) }
  return Number(v) || 0
}

// Composite reputation score: WoT trust * 100 + log10(zap_sats) * 10 + completed_jobs * 5 + avg_rating * 20 + attest_score * 15
function calcReputationScore(trustedBy: number, zapSats: number, completed: number, avgRating?: number, attestScore?: number): number {
  return trustedBy * 100
    + (zapSats > 0 ? Math.floor(Math.log10(zapSats) * 10) : 0)
    + completed * 5
    + Math.floor((avgRating || 0) * 20)
    + Math.floor((attestScore || 0) * 15)
}

function buildReputationData(svc: {
  jobsCompleted: number | null
  jobsRejected: number | null
  totalEarnedMsats: number | null
  totalZapReceived: number | null
  avgResponseMs: number | null
  lastJobAt: Date | null
}, wotData?: { trusted_by: number; trusted_by_your_follows: number }, reviewData?: { avg_rating: number; review_count: number }, attestData?: { weighted_score: number; attestation_count: number }) {
  const completed = svc.jobsCompleted || 0
  const rejected = svc.jobsRejected || 0
  const total = completed + rejected
  const trustedBy = wotData?.trusted_by || 0
  const zapSats = svc.totalZapReceived || 0
  const avgRating = reviewData?.avg_rating || 0
  const attestScore = attestData?.weighted_score || 0
  return {
    score: calcReputationScore(trustedBy, zapSats, completed, avgRating, attestScore),
    wot: wotData || { trusted_by: 0, trusted_by_your_follows: 0 },
    zaps: { total_received_sats: zapSats },
    reviews: reviewData || { avg_rating: 0, review_count: 0 },
    attestations: attestData || { weighted_score: 0, attestation_count: 0 },
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
    models: dvmServices.models,
    skill: dvmServices.skill,
    jobsCompleted: dvmServices.jobsCompleted,
    jobsRejected: dvmServices.jobsRejected,
    totalEarnedMsats: dvmServices.totalEarnedMsats,
    lastJobAt: dvmServices.lastJobAt,
    completedJobsCount: sql<number>`(SELECT COUNT(*) FROM dvm_job WHERE dvm_job.provider_pubkey = "user".nostr_pubkey AND dvm_job.status = 'completed')`,
    earnedMsats: sql<number>`(SELECT COALESCE(SUM(COALESCE(dvm_job.price_msats, dvm_job.bid_msats, 0)), 0) FROM dvm_job WHERE dvm_job.provider_pubkey = "user".nostr_pubkey AND dvm_job.status = 'completed')`,
    spentMsats: sql<number>`(SELECT COALESCE(SUM(COALESCE(dvm_job.price_msats, dvm_job.bid_msats, 0)), 0) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'customer' AND dvm_job.status IN ('completed', 'result_available'))`,
    lastSeenAt: sql<number>`(SELECT CAST(strftime('%s', MAX(dvm_job.updated_at)) AS INTEGER) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id)`,
    avgResponseMs: dvmServices.avgResponseMs,
    reportCount: sql<number>`(SELECT COUNT(DISTINCT reporter_pubkey) FROM nostr_report WHERE target_pubkey = "user".nostr_pubkey)`,
    trustedBy: sql<number>`(SELECT COUNT(*) FROM dvm_trust WHERE dvm_trust.target_pubkey = "user".nostr_pubkey)`,
    avgRating: sql<number>`(SELECT COALESCE(AVG(dvm_review.rating), 0) FROM dvm_review WHERE dvm_review.target_pubkey = "user".nostr_pubkey)`,
    reviewCount: sql<number>`(SELECT COUNT(*) FROM dvm_review WHERE dvm_review.target_pubkey = "user".nostr_pubkey)`,
    avgAttestScore: sql<number>`(SELECT COALESCE(AVG(da.rating * da.confidence), 0) FROM dvm_attestation da WHERE da.subject_pubkey = "user".nostr_pubkey AND da.expires_at > strftime('%s','now'))`,
    attestCount: sql<number>`(SELECT COUNT(*) FROM dvm_attestation da WHERE da.subject_pubkey = "user".nostr_pubkey AND da.expires_at > strftime('%s','now'))`,
    onlineStatus: sql<string>`(SELECT ah.status FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    heartbeatCapacity: sql<number>`(SELECT ah.capacity FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    heartbeatPricing: sql<string>`(SELECT ah.pricing FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    heartbeatP2pStats: sql<string>`(SELECT ah.p2p_stats FROM agent_heartbeat ah WHERE ah.user_id = dvm_service.user_id)`,
    notesPublished: sql<number>`(SELECT COUNT(*) FROM relay_event WHERE relay_event.kind = 1 AND relay_event.pubkey = "user".nostr_pubkey)`,
    likesGiven: sql<number>`(SELECT COUNT(*) FROM relay_event WHERE relay_event.kind = 7 AND relay_event.pubkey = "user".nostr_pubkey)`,
    jobsPostedCount: sql<number>`(SELECT COUNT(*) FROM dvm_job WHERE dvm_job.user_id = dvm_service.user_id AND dvm_job.role = 'customer')`,
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
      models: row.models ? JSON.parse(row.models) : [],
      features: (() => { try { return row.skill ? (JSON.parse(row.skill).features || []) : [] } catch { return [] } })(),
      skill_name: (() => { try { return row.skill ? (JSON.parse(row.skill).name || null) : null } catch { return null } })(),
      completed_jobs_count: row.completedJobsCount || 0,
      earned_sats: Math.floor((row.earnedMsats || 0) / 1000),
      spent_sats: Math.floor(((row as any).spentMsats || 0) / 1000),
      notes_published: (row as any).notesPublished || 0,
      likes_given: (row as any).likesGiven || 0,
      jobs_posted_count: (row as any).jobsPostedCount || 0,
      // Normalize to Unix seconds integer (D1 may return Date objects for timestamp columns)
      last_seen_at: row.lastSeenAt ? toUnixSecs(row.lastSeenAt) : null,
      avg_response_time_s: row.avgResponseMs ? Math.round(row.avgResponseMs / 1000) : null,
      total_zap_received_sats: row.totalZapReceived || 0,
      direct_request_enabled: !!row.directRequestEnabled,
      report_count: row.reportCount || 0,
      flagged: (row.reportCount || 0) >= REPORT_FLAG_THRESHOLD,
      live: row.onlineStatus === 'online',
      online_status: row.onlineStatus || 'unknown',
      capacity: row.heartbeatCapacity || 0,
      pricing: row.heartbeatPricing ? JSON.parse(row.heartbeatPricing) : null,
      p2p_stats: row.heartbeatP2pStats ? JSON.parse(row.heartbeatP2pStats) : null,
      reputation: buildReputationData(row, {
        trusted_by: row.trustedBy || 0,
        trusted_by_your_follows: 0,
      }, {
        avg_rating: row.avgRating ? Math.round(row.avgRating * 100) / 100 : 0,
        review_count: row.reviewCount || 0,
      }, {
        weighted_score: row.avgAttestScore ? Math.round(row.avgAttestScore * 100) / 100 : 0,
        attestation_count: row.attestCount || 0,
      }),
      _sort_ts: row.lastSeenAt ? toUnixSecs(row.lastSeenAt) : 0,
    }
  })

  // --- Customer-only agents: registered users with jobs but no active dvmService ---
  // Single query: users with at least one dvm_job but no active dvm_service entry
  const customerResult = await db.$client.execute(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.nostr_pubkey, u.lightning_address,
      (SELECT COUNT(*) FROM dvm_job WHERE dvm_job.user_id = u.id AND dvm_job.role = 'customer') AS jobs_posted_count,
      (SELECT COALESCE(SUM(COALESCE(price_msats, bid_msats, 0)), 0) FROM dvm_job WHERE dvm_job.user_id = u.id AND dvm_job.role = 'customer' AND status IN ('completed','result_available')) AS spent_msats,
      (SELECT CAST(strftime('%s', MAX(updated_at)) AS INTEGER) FROM dvm_job WHERE dvm_job.user_id = u.id) AS last_seen_at
    FROM user u
    WHERE u.nostr_pubkey IS NOT NULL
      AND EXISTS (SELECT 1 FROM dvm_job WHERE dvm_job.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM dvm_service WHERE dvm_service.user_id = u.id AND dvm_service.active = 1)
  `)
  const customerRows = customerResult.rows as unknown as { id: string; username: string; display_name: string | null; avatar_url: string | null; bio: string | null; nostr_pubkey: string; lightning_address: string | null; jobs_posted_count: number; spent_msats: number; last_seen_at: number | null }[]
  console.log(`[Cache] customerRows=${customerRows.length}`)

  const customerAgents = customerRows.map(row => {
    const spentSats = Math.floor((row.spent_msats || 0) / 1000)
    const jobsPosted = row.jobs_posted_count || 0
    return {
      source: 'local' as const,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      bio: row.bio,
      nostr_pubkey: row.nostr_pubkey,
      npub: row.nostr_pubkey ? pubkeyToNpub(row.nostr_pubkey) : null,
      services: [],
      models: [],
      features: [],
      skill_name: null,
      completed_jobs_count: 0,
      earned_sats: 0,
      spent_sats: spentSats,
      jobs_posted_count: jobsPosted,
      notes_published: 0,
      replies_sent: 0,
      replies_received: 0,
      zaps_received: 0,
      likes_given: 0,
      likes_received: 0,
      last_seen_at: row.last_seen_at ? toUnixSecs(row.last_seen_at) : null,
      avg_response_time_s: null,
      total_zap_received_sats: 0,
      direct_request_enabled: false,
      report_count: 0,
      flagged: false,
      live: false,
      online_status: 'unknown',
      capacity: 0,
      pricing: null,
      p2p_stats: null,
      reputation: { score: jobsPosted * 2, wot: { trusted_by: 0, trusted_by_your_follows: 0 }, zaps: { total_received_sats: 0 }, reviews: { avg_rating: 0, review_count: 0 }, platform: { jobs_completed: 0, jobs_rejected: 0, completion_rate: 0, avg_response_s: null, total_earned_sats: 0, last_job_at: null } },
      _sort_ts: row.last_seen_at ? toUnixSecs(row.last_seen_at) : 0,
    }
  })

  // --- External agents (from external_dvm table) ---
  // Exclude pubkeys already in localAgents or customerAgents to avoid duplicates
  const localPubkeys = new Set([
    ...localRows.map(r => r.nostrPubkey).filter(Boolean),
    ...customerRows.map(r => r.nostr_pubkey).filter(Boolean),
  ])
  const extRows = await db.select().from(externalDvms)
  const byPubkey = new Map<string, typeof extRows>()
  for (const row of extRows) {
    if (localPubkeys.has(row.pubkey)) continue
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
      features: [],
      skill_name: null,
      completed_jobs_count: 0,
      earned_sats: 0,
      last_seen_at: latest.eventCreatedAt,
      avg_response_time_s: null,
      total_zap_received_sats: 0,
      direct_request_enabled: false,
      report_count: 0,
      flagged: false,
      live: false,
      reputation: buildReputationData({
        jobsCompleted: 0, jobsRejected: 0, totalEarnedMsats: 0,
        totalZapReceived: 0, avgResponseMs: null, lastJobAt: null,
      }, { trusted_by: extTrustCounts.get(pubkey) || 0, trusted_by_your_follows: 0 }),
      _sort_ts: latest.eventCreatedAt,
    })
  }

  // Sort: live agents first, then by reputation score, then by last_seen
  const agentSortKey = (a: any) =>
    (a.live ? 1e15 : 0) + (a.reputation?.score || 0) * 1e6 + (a._sort_ts || 0)

  localAgents.sort((a, b) => agentSortKey(b) - agentSortKey(a))
  customerAgents.sort((a, b) => agentSortKey(b) - agentSortKey(a))
  externalAgents.sort((a, b) => agentSortKey(b) - agentSortKey(a))

  const stripSort = (arr: any[]) => arr.map(({ _sort_ts, ...rest }) => rest)
  const allClean = stripSort([...localAgents, ...customerAgents, ...externalAgents])
  const localClean = stripSort([...localAgents, ...customerAgents])
  const nostrClean = stripSort(externalAgents)

  // Write all three source variants to KV (TTL 300s safety net; Cron refreshes every 60s)
  await Promise.all([
    env.KV.put('agents_cache_all', JSON.stringify(allClean), { expirationTtl: 300 }),
    env.KV.put('agents_cache_local', JSON.stringify(localClean), { expirationTtl: 300 }),
    env.KV.put('agents_cache_nostr', JSON.stringify(nostrClean), { expirationTtl: 300 }),
  ])

  console.log(`[Cache] Agents refreshed: ${localAgents.length} providers, ${customerAgents.length} customers, ${nostrClean.length} external`)
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
