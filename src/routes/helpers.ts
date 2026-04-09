import { sql, eq, and, gt } from 'drizzle-orm'
import { dvmTrust, dvmReviews, dvmAttestations, userFollows } from '../db/schema'
import type { Database } from '../db'

export const REPORT_FLAG_THRESHOLD = 3

export const DVM_KIND_LABELS: Record<number, string> = {
  5001: 'summarization', 5002: 'translation', 5050: 'text generation',
  5100: 'image generation', 5200: 'text-to-image', 5250: 'video generation',
  5300: 'content discovery', 5301: 'speech-to-text',
}

export async function getWotData(db: Database, targetPubkey: string, viewerUserId?: string) {
  const trustedByResult = await db.select({ count: sql<number>`COUNT(*)` })
    .from(dvmTrust).where(eq(dvmTrust.targetPubkey, targetPubkey))
  const trustedBy = trustedByResult[0]?.count || 0

  let trustedByYourFollows = 0
  if (viewerUserId) {
    const followTrustResult = await db.select({ count: sql<number>`COUNT(*)` })
      .from(dvmTrust)
      .innerJoin(userFollows, eq(dvmTrust.userId, userFollows.followeeId))
      .where(and(eq(dvmTrust.targetPubkey, targetPubkey), eq(userFollows.followerId, viewerUserId)))
    trustedByYourFollows = followTrustResult[0]?.count || 0
  }

  return { trusted_by: trustedBy, trusted_by_your_follows: trustedByYourFollows }
}

export function buildReputationData(svc: {
  jobsCompleted: number | null
  jobsRejected: number | null
  totalEarnedMsats: number | null
  totalZapReceived: number | null
  avgResponseMs: number | null
  lastJobAt: Date | null
}, wotData?: { trusted_by: number; trusted_by_your_follows: number }, reviewData?: { avg_rating: number; review_count: number }, attestationData?: { weighted_score: number; attestation_count: number }) {
  const completed = svc.jobsCompleted || 0
  const rejected = svc.jobsRejected || 0
  const total = completed + rejected
  const trustedBy = wotData?.trusted_by || 0
  const zapSats = svc.totalZapReceived || 0
  const avgRating = reviewData?.avg_rating || 0
  const attestScore = attestationData?.weighted_score || 0
  // attestation signal: up to +75 pts at 5.0, with temporal decay already baked in
  const score = trustedBy * 100
    + (zapSats > 0 ? Math.floor(Math.log10(zapSats) * 10) : 0)
    + completed * 5
    + Math.floor(avgRating * 20)
    + Math.floor(attestScore * 15)
  return {
    score,
    wot: wotData || { trusted_by: 0, trusted_by_your_follows: 0 },
    zaps: { total_received_sats: zapSats },
    reviews: reviewData || { avg_rating: 0, review_count: 0 },
    attestations: attestationData || { weighted_score: 0, attestation_count: 0 },
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

export async function getReviewData(db: Database, targetPubkey: string) {
  const result = await db.select({
    avgRating: sql<number>`COALESCE(AVG(rating), 0)`,
    reviewCount: sql<number>`COUNT(*)`,
  }).from(dvmReviews).where(eq(dvmReviews.targetPubkey, targetPubkey))
  return {
    avg_rating: result[0]?.avgRating ? Math.round(result[0].avgRating * 100) / 100 : 0,
    review_count: result[0]?.reviewCount || 0,
  }
}

// Temporal decay: half-life 90 days, same as NIP-XX spec default
function attestationDecay(nostrCreatedAt: number): number {
  const ageSeconds = Math.floor(Date.now() / 1000) - nostrCreatedAt
  return Math.pow(2, -ageSeconds / (90 * 86400))
}

export async function getAttestationData(db: Database, targetPubkey: string) {
  const now = Math.floor(Date.now() / 1000)
  const rows = await db.select()
    .from(dvmAttestations)
    .where(and(
      eq(dvmAttestations.subjectPubkey, targetPubkey),
      gt(dvmAttestations.expiresAt, now),
    ))

  if (rows.length === 0) return { weighted_score: 0, attestation_count: 0 }

  let weightedSum = 0
  let weightSum = 0
  for (const row of rows) {
    const decay = attestationDecay(row.nostrCreatedAt)
    // Negative attestations (1-2) get 2x weight per spec
    const negMultiplier = row.rating <= 2 ? 2 : 1
    const weight = row.confidence * decay * negMultiplier
    weightedSum += row.rating * weight
    weightSum += weight
  }

  const weightedScore = weightSum > 0 ? Math.round((weightedSum / weightSum) * 100) / 100 : 0
  return { weighted_score: weightedScore, attestation_count: rows.length }
}

export function paginationMeta(total: number, page: number, limit: number) {
  return {
    current_page: page,
    per_page: limit,
    total,
    last_page: Math.max(1, Math.ceil(total / limit)),
  }
}
