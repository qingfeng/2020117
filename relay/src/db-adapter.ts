/**
 * DbAdapter — abstract database interface for the relay.
 *
 * Supports three backends, selected by environment config:
 *   1. Cloudflare D1  (env.D1 binding present)
 *   2. Local SQLite   (env.SQLITE_PATH = './relay.db')  — Bun/Node standalone mode
 *   3. Turso remote   (env.RELAY_TURSO_URL + RELAY_TURSO_TOKEN)  — default
 *
 * Usage in relay-do.ts / server.ts:
 *   const db = libsqlAdapter(createClient({ url, authToken }))
 *   const db = d1Adapter(env.D1)
 */

export interface DbResult {
  rows: any[]
  rowsAffected: number
}

export interface DbAdapter {
  execute(query: { sql: string; args?: any[] }): Promise<DbResult>
  batch(queries: { sql: string; args?: any[] }[]): Promise<void>
}

/** Wrap an @libsql/client Client (Turso remote OR local SQLite file). */
export function libsqlAdapter(client: { execute: Function; batch: Function }): DbAdapter {
  return {
    async execute({ sql, args = [] }) {
      const r = await client.execute({ sql, args })
      return { rows: r.rows as any[], rowsAffected: r.rowsAffected ?? 0 }
    },
    async batch(stmts) {
      await client.batch(stmts)
    },
  }
}

/** Wrap a Cloudflare D1Database binding. */
export function d1Adapter(d1: D1Database): DbAdapter {
  return {
    async execute({ sql, args = [] }) {
      const r = await d1.prepare(sql).bind(...args).all()
      return { rows: (r.results ?? []) as any[], rowsAffected: (r.meta as any)?.changes ?? 0 }
    },
    async batch(stmts) {
      await d1.batch(stmts.map(({ sql, args = [] }) => d1.prepare(sql).bind(...args)))
    },
  }
}
