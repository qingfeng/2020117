import type { NostrEvent, NostrFilter } from './types'
import { isReplaceable, isParameterizedReplaceable, isEphemeral } from './types'

/**
 * Save an event to D1. Handles replaceable/parameterized-replaceable logic.
 * Returns true if saved (new), false if duplicate or older.
 */
export async function saveEvent(db: D1Database, event: NostrEvent): Promise<boolean> {
  // Don't store ephemeral events
  if (isEphemeral(event.kind)) return false

  // Check duplicate
  const existing = await db
    .prepare('SELECT id FROM events WHERE id = ?')
    .bind(event.id)
    .first()
  if (existing) return false

  // Replaceable events: delete older versions
  if (isReplaceable(event.kind)) {
    const older = await db
      .prepare('SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1')
      .bind(event.pubkey, event.kind)
      .first<{ id: string; created_at: number }>()

    if (older) {
      if (older.created_at > event.created_at) return false // incoming is older
      // Delete old version
      await db.prepare('DELETE FROM event_tags WHERE event_id = ?').bind(older.id).run()
      await db.prepare('DELETE FROM events WHERE id = ?').bind(older.id).run()
    }
  }

  // Parameterized replaceable: (kind, pubkey, d-tag) unique
  if (isParameterizedReplaceable(event.kind)) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || ''
    const older = await db
      .prepare(`
        SELECT e.id, e.created_at FROM events e
        JOIN event_tags et ON et.event_id = e.id AND et.tag_name = 'd' AND et.tag_value = ?
        WHERE e.pubkey = ? AND e.kind = ?
        LIMIT 1
      `)
      .bind(dTag, event.pubkey, event.kind)
      .first<{ id: string; created_at: number }>()

    if (older) {
      if (older.created_at > event.created_at) return false
      await db.prepare('DELETE FROM event_tags WHERE event_id = ?').bind(older.id).run()
      await db.prepare('DELETE FROM events WHERE id = ?').bind(older.id).run()
    }
  }

  // Handle kind 5 deletion events
  if (event.kind === 5) {
    await processDeletion(db, event)
  }

  // Insert event
  await db
    .prepare('INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig)
    .run()

  // Index tags (single-letter tags with values)
  const tagInserts: D1PreparedStatement[] = []
  for (const tag of event.tags) {
    if (tag.length >= 2 && tag[0].length === 1) {
      tagInserts.push(
        db.prepare('INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)')
          .bind(event.id, tag[0], tag[1])
      )
    }
  }
  if (tagInserts.length > 0) {
    await db.batch(tagInserts)
  }

  return true
}

/**
 * Process kind 5 deletion: delete events referenced by e-tags if authored by same pubkey
 */
async function processDeletion(db: D1Database, event: NostrEvent): Promise<void> {
  const eTagIds = event.tags.filter(t => t[0] === 'e').map(t => t[1])
  for (const targetId of eTagIds) {
    const target = await db
      .prepare('SELECT pubkey FROM events WHERE id = ?')
      .bind(targetId)
      .first<{ pubkey: string }>()
    if (target && target.pubkey === event.pubkey) {
      await db.prepare('DELETE FROM event_tags WHERE event_id = ?').bind(targetId).run()
      await db.prepare('DELETE FROM events WHERE id = ?').bind(targetId).run()
    }
  }
}

/**
 * Query events matching a NIP-01 filter
 */
export async function queryEvents(db: D1Database, filter: NostrFilter): Promise<NostrEvent[]> {
  const conditions: string[] = []
  const binds: any[] = []
  let needsTagJoin = false

  if (filter.ids && filter.ids.length > 0) {
    conditions.push(`e.id IN (${filter.ids.map(() => '?').join(',')})`)
    binds.push(...filter.ids)
  }

  if (filter.authors && filter.authors.length > 0) {
    conditions.push(`e.pubkey IN (${filter.authors.map(() => '?').join(',')})`)
    binds.push(...filter.authors)
  }

  if (filter.kinds && filter.kinds.length > 0) {
    conditions.push(`e.kind IN (${filter.kinds.map(() => '?').join(',')})`)
    binds.push(...filter.kinds)
  }

  if (filter.since) {
    conditions.push('e.created_at >= ?')
    binds.push(filter.since)
  }

  if (filter.until) {
    conditions.push('e.created_at <= ?')
    binds.push(filter.until)
  }

  // Tag filters: #e, #p, #a, #t, #d
  const tagFilters: [string, string[]][] = []
  for (const key of Object.keys(filter) as (keyof NostrFilter)[]) {
    if (typeof key === 'string' && key.startsWith('#') && key.length === 2) {
      const tagName = key[1]
      const values = filter[key] as string[] | undefined
      if (values && values.length > 0) {
        tagFilters.push([tagName, values])
      }
    }
  }

  // Each tag filter is a separate EXISTS subquery
  for (const [tagName, values] of tagFilters) {
    const placeholders = values.map(() => '?').join(',')
    conditions.push(`EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag_name = ? AND et.tag_value IN (${placeholders}))`)
    binds.push(tagName, ...values)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(filter.limit || 500, 500)

  const sql = `SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig FROM events e ${where} ORDER BY e.created_at DESC LIMIT ?`
  binds.push(limit)

  const stmt = db.prepare(sql)
  const result = await stmt.bind(...binds).all<{
    id: string; pubkey: string; created_at: number; kind: number; tags: string; content: string; sig: string
  }>()

  return (result.results || []).map(row => ({
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags),
    content: row.content,
    sig: row.sig,
  }))
}

/**
 * Check if a pubkey belongs to a registered user or group (shared D1)
 */
export async function isAllowedPubkey(appDb: D1Database, pubkey: string): Promise<boolean> {
  const user = await appDb
    .prepare('SELECT id FROM user WHERE nostr_pubkey = ?')
    .bind(pubkey)
    .first()
  if (user) return true

  const group = await appDb
    .prepare('SELECT id FROM "group" WHERE nostr_pubkey = ?')
    .bind(pubkey)
    .first()
  return !!group
}

/**
 * Prune old events (keep recent, protect metadata kinds)
 */
export async function pruneOldEvents(db: D1Database, maxAgeDays: number = 90): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400
  // Don't delete kind 0 (metadata), 3 (contacts), 10002 (relay list), 34550 (community)
  const protectedKinds = [0, 3, 10002, 34550]
  const placeholders = protectedKinds.map(() => '?').join(',')

  // Delete tags first
  await db
    .prepare(`DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE created_at < ? AND kind NOT IN (${placeholders}))`)
    .bind(cutoff, ...protectedKinds)
    .run()

  const result = await db
    .prepare(`DELETE FROM events WHERE created_at < ? AND kind NOT IN (${placeholders})`)
    .bind(cutoff, ...protectedKinds)
    .run()

  return result.meta?.changes || 0
}
