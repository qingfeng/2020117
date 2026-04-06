import { eq, and, sql, isNotNull, inArray } from 'drizzle-orm'
import type { Database } from '../db'
import type { Bindings } from '../types'
import { users, topics, nostrFollows, externalDvms, relayEvents } from '../db/schema'
import type { User } from '../db/schema'
import {
  type NostrEvent,
  verifyEvent,
  pubkeyToNpub,
} from './nostr'
import { fetchEventsFromRelay } from './relay-io'
import { generateId, ensureUniqueUsername } from '../lib/utils'

type ProfileMetadata = {
  name?: string
  display_name?: string
  about?: string
  picture?: string
  lud16?: string
}

function normalizeProfileValue(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function resolveProfileDisplayName(meta: ProfileMetadata): string | null {
  return normalizeProfileValue(meta.display_name) || normalizeProfileValue(meta.name)
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

// --- NIP-02 Kind 3 Contact List Sync ---

/**
 * Fetch the user's latest Kind 3 from relay, merge with local follows,
 * save new follows to local DB, then publish merged Kind 3.
 */
export async function syncAndPublishContactList(db: Database, env: Bindings, user: User) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0 || !user.nostrPubkey) return

  // 1. Get local follows
  const localFollows = await db
    .select({ targetPubkey: nostrFollows.targetPubkey })
    .from(nostrFollows)
    .where(eq(nostrFollows.userId, user.id))
  const localPubkeys = new Set(localFollows.map(f => f.targetPubkey))

  // 2. Fetch latest Kind 3 from relay
  const relayPubkeys = new Set<string>()
  try {
    const { events } = await fetchEventsFromRelay(relayUrls[0], {
      kinds: [3],
      authors: [user.nostrPubkey],
      limit: 1,
    })
    if (events.length > 0) {
      // Take the most recent Kind 3
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
      for (const tag of latest.tags) {
        if (tag[0] === 'p' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1])) {
          relayPubkeys.add(tag[1].toLowerCase())
        }
      }
    }
  } catch (e) {
    console.error('[Nostr K3] Failed to fetch Kind 3 from relay:', e)
  }

  // 3. Import new follows from relay to local DB
  for (const pk of relayPubkeys) {
    if (localPubkeys.has(pk)) continue
    try {
      await db.insert(nostrFollows).values({
        id: generateId(),
        userId: user.id,
        targetPubkey: pk,
        targetNpub: pubkeyToNpub(pk),
        createdAt: new Date(),
      })
      localPubkeys.add(pk)
      console.log(`[Nostr K3] Imported follow ${pk.slice(0, 8)}... from relay for user ${user.id}`)
    } catch (e) {
      // Likely unique constraint — already exists
    }
  }

}

/**
 * Cron: sync Kind 3 contact lists from relay for all Nostr-enabled users.
 */
export async function syncContactListsFromRelay(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  // Get all users with Nostr sync enabled and a pubkey
  const nostrUsers = await db
    .select({
      id: users.id,
      nostrPubkey: users.nostrPubkey,
    })
    .from(users)
    .where(and(eq(users.nostrSyncEnabled, 1), sql`${users.nostrPubkey} IS NOT NULL`))

  if (nostrUsers.length === 0) return

  const relayUrl = relayUrls[0]

  // Batch fetch: get all Kind 3 events for all users at once
  const pubkeys = nostrUsers.map(u => u.nostrPubkey!).filter(Boolean)
  let kind3Events: NostrEvent[] = []
  try {
    const k3Result = await fetchEventsFromRelay(relayUrl, {
      kinds: [3],
      authors: pubkeys,
    })
    kind3Events = k3Result.events
  } catch (e) {
    console.error('[Nostr K3 Sync] Failed to fetch Kind 3 events:', e)
    return
  }

  // Group by author, keep latest per author
  const latestByAuthor = new Map<string, NostrEvent>()
  for (const ev of kind3Events) {
    const existing = latestByAuthor.get(ev.pubkey)
    if (!existing || ev.created_at > existing.created_at) {
      latestByAuthor.set(ev.pubkey, ev)
    }
  }

  // For each user, import new follows from their Kind 3
  for (const u of nostrUsers) {
    const event = latestByAuthor.get(u.nostrPubkey!)
    if (!event) continue

    const relayFollowPubkeys: string[] = []
    for (const tag of event.tags) {
      if (tag[0] === 'p' && tag[1] && /^[0-9a-f]{64}$/i.test(tag[1])) {
        relayFollowPubkeys.push(tag[1].toLowerCase())
      }
    }

    if (relayFollowPubkeys.length === 0) continue

    // Get existing local follows
    const localFollows = await db
      .select({ targetPubkey: nostrFollows.targetPubkey })
      .from(nostrFollows)
      .where(eq(nostrFollows.userId, u.id))
    const localSet = new Set(localFollows.map(f => f.targetPubkey))

    let imported = 0
    for (const pk of relayFollowPubkeys) {
      if (localSet.has(pk)) continue
      try {
        await db.insert(nostrFollows).values({
          id: generateId(),
          userId: u.id,
          targetPubkey: pk,
          targetNpub: pubkeyToNpub(pk),
          createdAt: new Date(),
        })
        imported++
      } catch (e) {
        // Unique constraint — skip
      }
    }

    if (imported > 0) {
      console.log(`[Nostr K3 Sync] Imported ${imported} follows from relay for user ${u.id}`)
    }
  }
}

// --- Poll own user posts from external Nostr clients (e.g. Damus) ---

export async function pollOwnUserPosts(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (relayUrls.length === 0) return

  const relayUrl = relayUrls[0]
  const KV_KEY = 'nostr_own_posts_last_poll'

  // Get last poll timestamp from KV
  let since = Math.floor(Date.now() / 1000) - 3600 // Default: last hour
  if (env.KV) {
    const stored = await env.KV.get(KV_KEY)
    if (stored) since = parseInt(stored, 10)
  }

  // Get all local users with Nostr sync enabled
  const nostrUsers = await db
    .select({
      id: users.id,
      nostrPubkey: users.nostrPubkey,
    })
    .from(users)
    .where(and(eq(users.nostrSyncEnabled, 1), isNotNull(users.nostrPubkey)))

  if (nostrUsers.length === 0) return

  // Build pubkey → user map for fast lookup
  const pubkeyToUser = new Map<string, { id: string }>()
  for (const u of nostrUsers) {
    if (u.nostrPubkey) {
      pubkeyToUser.set(u.nostrPubkey, { id: u.id })
    }
  }

  const BATCH_SIZE = 50
  let maxCreatedAt = since

  for (let i = 0; i < nostrUsers.length; i += BATCH_SIZE) {
    const batch = nostrUsers.slice(i, i + BATCH_SIZE)
    const pubkeys = batch.map(u => u.nostrPubkey!).filter(Boolean)

    try {
      const { events } = await fetchEventsFromRelay(relayUrl, {
        kinds: [1],
        authors: pubkeys,
        since,
      })

      console.log(`[Nostr OwnPosts] Fetched ${events.length} events from ${pubkeys.length} own users since ${since}`)

      for (const event of events) {
        try {
          if (!verifyEvent(event)) continue

          // Dedup: skip if already imported (covers posts created from NeoGroup)
          const existing = await db.select({ id: topics.id })
            .from(topics)
            .where(eq(topics.nostrEventId, event.id))
            .limit(1)
          if (existing.length > 0) continue

          // Skip NIP-72 community posts (handled by pollCommunityPosts)
          const hasATag = event.tags.some(t => t[0] === 'a' && t[1]?.startsWith('34550:'))
          if (hasATag) continue

          // Skip replies (handled by pollNostrReplies)
          const hasETag = event.tags.some(t => t[0] === 'e')
          if (hasETag) continue

          // Reject future timestamps
          const nowSec = Math.floor(Date.now() / 1000)
          if (event.created_at > nowSec + 600) continue

          // Find the local user (not shadow user)
          const localUser = pubkeyToUser.get(event.pubkey)
          if (!localUser) continue

          // HTML escape + format
          const escaped = event.content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
          const htmlContent = escaped
            ? '<p>' + escaped.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
            : null

          const topicId = generateId()
          const topicNow = new Date(event.created_at * 1000)

          await db.insert(topics).values({
            id: topicId,
            groupId: null,
            userId: localUser.id,
            title: '',
            content: htmlContent,
            type: 0,
            nostrEventId: event.id,
            createdAt: topicNow,
            updatedAt: topicNow,
          })

          console.log(`[Nostr OwnPosts] Imported post ${topicId} from own user ${event.pubkey.slice(0, 8)}...`)
        } catch (e) {
          console.error(`[Nostr OwnPosts] Failed to process event ${event.id}:`, e)
        }

        if (event.created_at > maxCreatedAt) maxCreatedAt = event.created_at
      }
    } catch (e) {
      console.error('[Nostr OwnPosts] Poll failed:', e)
    }
  }

  if (env.KV && maxCreatedAt > since) {
    await env.KV.put(KV_KEY, String(maxCreatedAt + 1))
  }
}

// --- Poll Kind 0 user metadata from relay → sync back to D1 ---

export async function pollUserMetadata(env: Bindings, db: Database) {
  const relayUrls = (env.NOSTR_RELAYS || '').split(',').map(s => s.trim()).filter(Boolean)
  // Always include the platform's own relay so agents publishing there get synced
  const ownRelay = env.NOSTR_RELAY_URL || 'wss://relay.2020117.xyz'
  if (!relayUrls.includes(ownRelay)) relayUrls.unshift(ownRelay)
  if (relayUrls.length === 0) return

  // Kind 0 is replaceable — relays store at most 1 per pubkey.
  // No `since` filter needed; we compare with D1 to skip unchanged profiles.

  // Get all Nostr-enabled users with current profile fields for comparison
  const nostrUsers = await db
    .select({
      id: users.id,
      username: users.username,
      nostrPubkey: users.nostrPubkey,
      displayName: users.displayName,
      bio: users.bio,
      avatarUrl: users.avatarUrl,
      lightningAddress: users.lightningAddress,
    })
    .from(users)
    .where(isNotNull(users.nostrPubkey))

  // Build pubkey → user map (shared between Phase A and Phase B)
  const pubkeyToUser = new Map<string, typeof nostrUsers[number]>()
  for (const u of nostrUsers) {
    if (u.nostrPubkey) pubkeyToUser.set(u.nostrPubkey, u)
  }

  const BATCH_SIZE = 50

  // --- Phase A: sync metadata for existing users ---
  for (let i = 0; i < nostrUsers.length; i += BATCH_SIZE) {
    const batch = nostrUsers.slice(i, i + BATCH_SIZE)
    const pubkeys = batch.map(u => u.nostrPubkey!).filter(Boolean)

    try {
      // Try all relays and merge (Kind 0 from external clients may land on different relays)
      const allEvents: NostrEvent[] = []
      const seenIds = new Set<string>()
      for (const relay of relayUrls) {
        try {
          const result = await fetchEventsFromRelay(relay, {
            kinds: [0],
            authors: pubkeys,
          })
          for (const e of result.events) {
            if (!seenIds.has(e.id)) {
              seenIds.add(e.id)
              allEvents.push(e)
            }
          }
          if (allEvents.length >= pubkeys.length) break // Got enough, one per user max
        } catch (e) {
          console.warn(`[Nostr Metadata] Relay ${relay} failed:`, e)
        }
      }

      console.log(`[Nostr Metadata] Fetched ${allEvents.length} Kind 0 events from ${pubkeys.length} users`)

      // Kind 0 is replaceable — keep only the latest per pubkey
      const latestByPubkey = new Map<string, NostrEvent>()
      for (const ev of allEvents) {
        const existing = latestByPubkey.get(ev.pubkey)
        if (!existing || ev.created_at > existing.created_at) {
          latestByPubkey.set(ev.pubkey, ev)
        }
      }

      let updated = 0
      for (const [pubkey, event] of latestByPubkey) {
        try {
          if (!verifyEvent(event)) continue

          const user = pubkeyToUser.get(pubkey)
          if (!user) continue

          let meta: ProfileMetadata
          try {
            meta = JSON.parse(event.content)
          } catch {
            continue
          }

          // Build update set — only fields that actually changed
          const updates: Record<string, string | null> = {}
          const resolvedName = resolveProfileDisplayName(meta)

          if ((meta.display_name !== undefined || meta.name !== undefined) && resolvedName !== normalizeProfileValue(user.displayName)) {
            updates.displayName = resolvedName
          }
          if (meta.about !== undefined && normalizeProfileValue(meta.about) !== normalizeProfileValue(user.bio)) {
            updates.bio = normalizeProfileValue(meta.about)
          }
          if (meta.picture !== undefined && normalizeProfileValue(meta.picture) !== normalizeProfileValue(user.avatarUrl)) {
            updates.avatarUrl = normalizeProfileValue(meta.picture)
          }
          if (meta.lud16 !== undefined && normalizeProfileValue(meta.lud16) !== normalizeProfileValue(user.lightningAddress)) {
            updates.lightningAddress = normalizeProfileValue(meta.lud16)
          }

          // Shadow users should inherit a stable username from Kind 0 so agent links stop
          // exposing placeholder nostr_<pubkey> slugs once real metadata exists.
          if (resolvedName && isShadowUsername(user.username)) {
            const nextBase = usernameBaseFromProfileName(resolvedName)
            if (nextBase !== user.username) {
              const nextUsername = await ensureUniqueUsername(db, nextBase)
              if (nextUsername !== user.username) {
                updates.username = nextUsername
              }
            }
          }

          if (Object.keys(updates).length === 0) continue

          await db.update(users).set({ ...updates, updatedAt: new Date() }).where(eq(users.id, user.id))
          updated++
          console.log(`[Nostr Metadata] Updated user ${user.id}: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(', ')}`)
        } catch (e) {
          console.error(`[Nostr Metadata] Failed to process event ${event.id}:`, e)
        }
      }

      if (updated > 0) {
        console.log(`[Nostr Metadata] Synced ${updated} user profiles`)
        // Bump cache version so relay_events KV caches across all pages are invalidated
        await env.KV.put('relay_cache_version', String(Date.now()))
      }
    } catch (e) {
      console.error('[Nostr Metadata] Poll failed:', e)
    }
  }

  // --- Phase B: auto-create users from any Kind 0 published to our relay ---
  // Gate: the relay already enforces POW >= 20 for Kind 0 (social kinds).
  // Any Kind 0 that made it into relay_events paid the entry cost — auto-register them.
  try {
    const PUBKEY_BLACKLIST = new Set([
      '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // secp256k1 generator point (nak test key)
    ])

    // Incremental: use our internal createdAt (indexing time) as cursor, NOT eventCreatedAt
    // (eventCreatedAt is set by the bot/client and may predate our cron run, causing events
    //  to be permanently skipped if the relay poll runs after Phase B advances the cursor)
    const sinceKey = 'phase_b_kind0_indexed_ts'
    const sinceStr = env.KV ? await env.KV.get(sinceKey) : null
    const since = sinceStr ? parseInt(sinceStr) : 0

    const kind0Rows = await db
      .selectDistinct({ pubkey: relayEvents.pubkey, indexedAt: relayEvents.createdAt })
      .from(relayEvents)
      .where(and(eq(relayEvents.kind, 0), sql`${relayEvents.createdAt} > ${since}`))
      .orderBy(relayEvents.createdAt)
      .limit(50)

    if (kind0Rows.length === 0) return

    // Filter out pubkeys already in user table
    const allUserPubkeys = await db
      .select({ nostrPubkey: users.nostrPubkey })
      .from(users)
      .where(isNotNull(users.nostrPubkey))
    const existingPubkeys = new Set(allUserPubkeys.map(u => u.nostrPubkey!))

    const missingPubkeys = kind0Rows
      .map(r => r.pubkey)
      .filter(pk => !existingPubkeys.has(pk) && !PUBKEY_BLACKLIST.has(pk))

    let maxTs = since
    for (const r of kind0Rows) {
      const ts = r.indexedAt instanceof Date ? Math.floor(r.indexedAt.getTime() / 1000) : Number(r.indexedAt)
      if (ts > maxTs) maxTs = ts
    }

    console.log(`[Nostr Metadata] Phase B: ${missingPubkeys.length} new Kind 0 pubkeys to register (since ${since})`)

    // Fetch full Kind 0 events from relay (need picture/lud16 not stored in content_preview)
    for (let i = 0; i < missingPubkeys.length; i += BATCH_SIZE) {
      const batch = missingPubkeys.slice(i, i + BATCH_SIZE)

      const allEvents: NostrEvent[] = []
      const seenIds = new Set<string>()
      for (const relay of relayUrls) {
        try {
          const result = await fetchEventsFromRelay(relay, { kinds: [0], authors: batch })
          for (const e of result.events) {
            if (!seenIds.has(e.id)) { seenIds.add(e.id); allEvents.push(e) }
          }
          if (allEvents.length >= batch.length) break
        } catch (e) {
          console.warn(`[Nostr Metadata] Phase B relay ${relay} failed:`, e)
        }
      }

      // Keep only latest Kind 0 per pubkey
      const latestByPubkey = new Map<string, NostrEvent>()
      for (const ev of allEvents) {
        const existing = latestByPubkey.get(ev.pubkey)
        if (!existing || ev.created_at > existing.created_at) latestByPubkey.set(ev.pubkey, ev)
      }

      for (const [pubkey, event] of latestByPubkey) {
        try {
          if (!verifyEvent(event)) continue

          let meta: ProfileMetadata
          try { meta = JSON.parse(event.content) } catch { continue }

          const rawName = resolveProfileDisplayName(meta) || ''
          const baseName = usernameBaseFromProfileName(rawName)
          const username = await ensureUniqueUsername(db, baseName)
          const userId = generateId()
          const now = new Date()

          await db.insert(users).values({
            id: userId,
            username,
            displayName: rawName || null,
            bio: normalizeProfileValue(meta.about),
            avatarUrl: normalizeProfileValue(meta.picture),
            lightningAddress: normalizeProfileValue(meta.lud16),
            nostrPubkey: pubkey,
            nostrSyncEnabled: 1,
            createdAt: now,
            updatedAt: now,
          })

          pubkeyToUser.set(pubkey, {
            id: userId, nostrPubkey: pubkey,
            username,
            displayName: rawName || null, bio: normalizeProfileValue(meta.about),
            avatarUrl: normalizeProfileValue(meta.picture), lightningAddress: normalizeProfileValue(meta.lud16),
          })

          console.log(`[Nostr Metadata] Phase B: registered ${username} from Kind 0 (pubkey=${pubkey.slice(0, 8)}...)`)
        } catch (e) {
          console.error(`[Nostr Metadata] Phase B failed for pubkey ${pubkey.slice(0, 8)}:`, e)
        }
      }
    }

    // Advance watermark
    if (maxTs > since && env.KV) await env.KV.put(sinceKey, String(maxTs))
  } catch (e) {
    console.error('[Nostr Metadata] Phase B failed:', e)
  }
}
