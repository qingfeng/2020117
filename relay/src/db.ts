import type { Client } from '@libsql/client'
import type { NostrEvent, NostrFilter } from './types'
import { isReplaceable, isParameterizedReplaceable, isEphemeral } from './types'

/**
 * Save an event to libSQL. Handles replaceable/parameterized-replaceable logic.
 * Returns true if saved (new), false if duplicate or older.
 */
export async function saveEvent(db: Client, event: NostrEvent): Promise<boolean> {
  if (isEphemeral(event.kind)) return false

  const existing = await db.execute({ sql: 'SELECT id FROM events WHERE id = ?', args: [event.id] })
  if (existing.rows.length > 0) return false

  if (isReplaceable(event.kind)) {
    const older = await db.execute({
      sql: 'SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? LIMIT 1',
      args: [event.pubkey, event.kind],
    })
    if (older.rows.length > 0) {
      const row = older.rows[0] as any
      if (row.created_at > event.created_at) return false
      await db.batch([
        { sql: 'DELETE FROM event_tags WHERE event_id = ?', args: [row.id] },
        { sql: 'DELETE FROM events WHERE id = ?', args: [row.id] },
      ])
    }
  }

  if (isParameterizedReplaceable(event.kind)) {
    const dTag = event.tags.find(t => t[0] === 'd')?.[1] || ''
    const older = await db.execute({
      sql: `SELECT e.id, e.created_at FROM events e
        JOIN event_tags et ON et.event_id = e.id AND et.tag_name = 'd' AND et.tag_value = ?
        WHERE e.pubkey = ? AND e.kind = ? LIMIT 1`,
      args: [dTag, event.pubkey, event.kind],
    })
    if (older.rows.length > 0) {
      const row = older.rows[0] as any
      if (row.created_at > event.created_at) return false
      await db.batch([
        { sql: 'DELETE FROM event_tags WHERE event_id = ?', args: [row.id] },
        { sql: 'DELETE FROM events WHERE id = ?', args: [row.id] },
      ])
    }
  }

  if (event.kind === 5) {
    await processDeletion(db, event)
  }

  const insertResult = await db.execute({
    sql: 'INSERT OR IGNORE INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [event.id, event.pubkey, event.created_at, event.kind, JSON.stringify(event.tags), event.content, event.sig],
  })
  if (!insertResult.rowsAffected) return false

  const tagInserts: { sql: string; args: any[] }[] = []
  for (const tag of event.tags) {
    if (tag.length >= 2 && tag[0].length === 1) {
      tagInserts.push({ sql: 'INSERT INTO event_tags (event_id, tag_name, tag_value) VALUES (?, ?, ?)', args: [event.id, tag[0], tag[1]] })
    }
  }
  if (tagInserts.length > 0) {
    await db.batch(tagInserts)
  }

  return true
}

async function processDeletion(db: Client, event: NostrEvent): Promise<void> {
  const eTagIds = event.tags.filter(t => t[0] === 'e').map(t => t[1])
  for (const targetId of eTagIds) {
    const target = await db.execute({ sql: 'SELECT pubkey FROM events WHERE id = ?', args: [targetId] })
    if (target.rows.length > 0 && (target.rows[0] as any).pubkey === event.pubkey) {
      await db.batch([
        { sql: 'DELETE FROM event_tags WHERE event_id = ?', args: [targetId] },
        { sql: 'DELETE FROM events WHERE id = ?', args: [targetId] },
      ])
    }
  }
}

export async function queryEvents(db: Client, filter: NostrFilter): Promise<NostrEvent[]> {
  const conditions: string[] = []
  const binds: any[] = []

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
  if (filter.since) { conditions.push('e.created_at >= ?'); binds.push(filter.since) }
  if (filter.until) { conditions.push('e.created_at <= ?'); binds.push(filter.until) }

  for (const key of Object.keys(filter) as (keyof NostrFilter)[]) {
    if (typeof key === 'string' && key.startsWith('#') && key.length === 2) {
      const tagName = key[1]
      const values = filter[key] as string[] | undefined
      if (values && values.length > 0) {
        const placeholders = values.map(() => '?').join(',')
        conditions.push(`EXISTS (SELECT 1 FROM event_tags et WHERE et.event_id = e.id AND et.tag_name = ? AND et.tag_value IN (${placeholders}))`)
        binds.push(tagName, ...values)
      }
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(filter.limit || 500, 500)
  binds.push(limit)

  const result = await db.execute({
    sql: `SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig FROM events e ${where} ORDER BY e.created_at DESC LIMIT ?`,
    args: binds,
  })

  return result.rows.map((row: any) => ({
    id: row.id, pubkey: row.pubkey, created_at: row.created_at,
    kind: row.kind, tags: JSON.parse(row.tags), content: row.content, sig: row.sig,
  }))
}

export async function isAllowedPubkey(appDb: Client, pubkey: string): Promise<boolean> {
  const user = await appDb.execute({ sql: 'SELECT id FROM user WHERE nostr_pubkey = ?', args: [pubkey] })
  if (user.rows.length > 0) return true
  const group = await appDb.execute({ sql: 'SELECT id FROM "group" WHERE nostr_pubkey = ?', args: [pubkey] })
  return group.rows.length > 0
}

export async function hasZappedRelay(db: Client, senderPubkey: string, relayPubkey: string): Promise<boolean> {
  const rows = await db.execute({
    sql: `SELECT e.tags FROM events e
      JOIN event_tags et ON et.event_id = e.id AND et.tag_name = 'p' AND et.tag_value = ?
      WHERE e.kind = 9735 ORDER BY e.created_at DESC LIMIT 50`,
    args: [relayPubkey],
  })
  for (const row of rows.rows as any[]) {
    try {
      const tags: string[][] = JSON.parse(row.tags)
      const descTag = tags.find(t => t[0] === 'description')
      if (!descTag?.[1]) continue
      const zapRequest = JSON.parse(descTag[1])
      if (zapRequest.pubkey === senderPubkey) return true
    } catch { continue }
  }
  return false
}

export async function pruneOldEvents(db: Client, maxAgeDays: number = 90): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400
  const jobCutoff = cutoff - 30 * 86400
  const protectedKinds = [0, 3, 10002, 34550]
  const placeholders = protectedKinds.map(() => '?').join(',')

  const deleteCondition = `
    created_at < ?
    AND kind NOT IN (${placeholders})
    AND NOT (
      kind >= 5000 AND kind <= 5999
      AND created_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM event_tags et
        JOIN events r ON r.id = et.event_id
        WHERE et.tag_name = 'e' AND et.tag_value = events.id
          AND r.kind >= 6000 AND r.kind <= 6999
      )
    )
  `
  const args = [cutoff, ...protectedKinds, jobCutoff]

  await db.execute({ sql: `DELETE FROM event_tags WHERE event_id IN (SELECT id FROM events WHERE ${deleteCondition})`, args })
  const result = await db.execute({ sql: `DELETE FROM events WHERE ${deleteCondition}`, args })
  return result.rowsAffected || 0
}
