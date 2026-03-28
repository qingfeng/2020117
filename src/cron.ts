import type { Bindings } from './types'

export async function scheduled(_event: ScheduledEvent, env: Bindings, _ctx: ExecutionContext) {
    const { createDb } = await import('./db')
    const db = createDb(env.DB)

    // Poll followed Nostr users
    try {
      const { pollFollowedUsers } = await import('./services/nostr-community')
      await pollFollowedUsers(env, db)
    } catch (e) {
      console.error('[Cron] Nostr follow poll failed:', e)
    }

    // Poll own user posts from external Nostr clients
    try {
      const { pollOwnUserPosts } = await import('./services/nostr-community')
      await pollOwnUserPosts(env, db)
    } catch (e) {
      console.error('[Cron] Own Nostr posts poll failed:', e)
    }

    // Poll Kind 0 user metadata from relay → sync profile fields back to D1
    try {
      const { pollUserMetadata } = await import('./services/nostr-community')
      await pollUserMetadata(env, db)
    } catch (e) {
      console.error('[Cron] User metadata poll failed:', e)
    }

    // NIP-72: poll Nostr relays for community posts
    try {
      const { pollCommunityPosts } = await import('./services/nostr-community')
      await pollCommunityPosts(env, db)
    } catch (e) {
      console.error('[Cron] NIP-72 poll failed:', e)
    }

    // Poll followed Nostr communities
    try {
      const { pollFollowedCommunities } = await import('./services/nostr-community')
      await pollFollowedCommunities(env, db)
    } catch (e) {
      console.error('[Cron] Nostr community follow poll failed:', e)
    }

    // Sync Kind 3 contact lists from relay
    try {
      const { syncContactListsFromRelay } = await import('./services/nostr-community')
      await syncContactListsFromRelay(env, db)
    } catch (e) {
      console.error('[Cron] Nostr contact list sync failed:', e)
    }

    // Poll Nostr Kind 7 reactions (likes)
    try {
      const { pollNostrReactions } = await import('./services/nostr-community')
      await pollNostrReactions(env, db)
    } catch (e) {
      console.error('[Cron] Nostr reactions poll failed:', e)
    }

    // Poll Nostr Kind 1 replies (comments)
    try {
      const { pollNostrReplies } = await import('./services/nostr-community')
      await pollNostrReplies(env, db)
    } catch (e) {
      console.error('[Cron] Nostr replies poll failed:', e)
    }

    // Poll DVM results (for customer jobs)
    try {
      const { pollDvmResults } = await import('./services/dvm')
      await pollDvmResults(env, db)
    } catch (e) {
      console.error('[Cron] DVM results poll failed:', e)
    }

    // Poll DVM requests (for service providers)
    try {
      const { pollDvmRequests } = await import('./services/dvm')
      await pollDvmRequests(env, db)
    } catch (e) {
      console.error('[Cron] DVM requests poll failed:', e)
    }

    // Poll Zap Receipts for DVM provider reputation
    try {
      const { pollProviderZaps } = await import('./services/dvm')
      await pollProviderZaps(env, db)
    } catch (e) {
      console.error('[Cron] DVM zap poll failed:', e)
    }

    // Poll Nostr Reports (Kind 1984) for DVM providers
    try {
      const { pollNostrReports } = await import('./services/dvm')
      await pollNostrReports(env, db)
    } catch (e) {
      console.error('[Cron] Nostr reports poll failed:', e)
    }

    // Poll External DVM Agents (Kind 31990) from relays
    try {
      const { pollExternalDvms } = await import('./services/dvm')
      await pollExternalDvms(env, db)
    } catch (e) {
      console.error('[Cron] External DVM poll failed:', e)
    }

    // Poll DVM Trust Declarations (Kind 30382)
    try {
      const { pollDvmTrust } = await import('./services/dvm')
      await pollDvmTrust(env, db)
    } catch (e) {
      console.error('[Cron] DVM trust poll failed:', e)
    }

    // Poll Agent Heartbeats (Kind 30333)
    try {
      const { pollHeartbeats } = await import('./services/dvm')
      await pollHeartbeats(env, db)
    } catch (e) {
      console.error('[Cron] Heartbeat poll failed:', e)
    }

    // Poll Job Reviews (Kind 31117)
    try {
      const { pollJobReviews } = await import('./services/dvm')
      await pollJobReviews(env, db)
    } catch (e) {
      console.error('[Cron] Job reviews poll failed:', e)
    }

    // Poll Kind 30085 Reputation Attestations (NIP-XX)
    try {
      const { pollAttestations } = await import('./services/dvm-polling')
      await pollAttestations(env, db)
    } catch (e) {
      console.error('[Cron] Attestation poll failed:', e)
    }

    // Poll Reputation Endorsements (Kind 30311)
    try {
      const { pollReputationEndorsements } = await import('./services/dvm')
      await pollReputationEndorsements(env, db)
    } catch (e) {
      console.error('[Cron] Reputation endorsement poll failed:', e)
    }

    // Poll relay events for timeline
    try {
      const { pollRelayEvents } = await import('./services/dvm')
      await pollRelayEvents(env, db)
    } catch (e) {
      console.error('[Cron] Relay event poll failed:', e)
    }

    // Index external provider jobs (6xxx results + 30311 P2P sessions)
    try {
      const { indexExternalProviderJobs } = await import('./services/dvm')
      await indexExternalProviderJobs(env, db)
    } catch (e) {
      console.error('[Cron] External provider job indexing failed:', e)
    }

    // Sync public relay events for @2020117.xyz users (our own accounts posting to damus/nos.lol)
    try {
      const { pollPublicRelayForUsers } = await import('./services/dvm')
      await pollPublicRelayForUsers(env, db)
    } catch (e) {
      console.error('[Cron] Public relay user sync failed:', e)
    }

    // Refresh KV caches (agents list + stats) after all data polls complete
    try {
      const { refreshAgentsCache, refreshStatsCache } = await import('./services/cache')
      await Promise.all([
        refreshAgentsCache(env, db),
        refreshStatsCache(env, db),
      ])
    } catch (e) {
      console.error('[Cache] Cache refresh failed:', e)
    }

    // Prune stale open jobs older than 7 days (will never be processed)
    try {
      await db.$client.prepare(
        "DELETE FROM dvm_job WHERE status = 'open' AND created_at < datetime('now', '-7 days')"
      ).run()
    } catch (e) {
      console.error('[Cron] Stale job prune failed:', e)
    }
}
