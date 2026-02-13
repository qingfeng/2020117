export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

export interface NostrFilter {
  ids?: string[]
  authors?: string[]
  kinds?: number[]
  '#e'?: string[]
  '#p'?: string[]
  '#a'?: string[]
  '#t'?: string[]
  '#d'?: string[]
  since?: number
  until?: number
  limit?: number
}

export interface Env {
  DB: D1Database
  APP_DB: D1Database
  RELAY_DO: DurableObjectNamespace
  RELAY_NAME: string
  RELAY_DESCRIPTION: string
  RELAY_CONTACT: string
  APP_WEBHOOK_URL?: string
  APP_WEBHOOK_SECRET?: string
}

// DVM event kinds — always writable (external agents submit results)
export function isDvmKind(kind: number): boolean {
  return (kind >= 6000 && kind <= 6999) || kind === 7000
}

// Replaceable event kinds (NIP-01): latest one replaces previous
// Kind 0 (metadata), Kind 3 (contacts), Kind 10000-19999
export function isReplaceable(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)
}

// Parameterized replaceable: identified by (kind, pubkey, d-tag)
// Kind 30000-39999
export function isParameterizedReplaceable(kind: number): boolean {
  return kind >= 30000 && kind < 40000
}

// Ephemeral events: not stored
// Kind 20000-29999
export function isEphemeral(kind: number): boolean {
  return kind >= 20000 && kind < 30000
}
