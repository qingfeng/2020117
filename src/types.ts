import type { Database } from './db'

export type Bindings = {
  TURSO_URL: string
  TURSO_TOKEN: string
  KV: KVNamespace
  APP_URL: string
  APP_NAME: string
  QUEUE?: Queue
  NOSTR_MASTER_KEY?: string
  NOSTR_RELAYS?: string
  NOSTR_RELAY_URL?: string
  NOSTR_MIN_POW?: string
  SYSTEM_NOSTR_PUBKEY?: string
  PLATFORM_FEE_PERCENT?: string
  PLATFORM_LIGHTNING_ADDRESS?: string
}

export type Variables = {
  db: Database
  user: import('./db/schema').User | null
}

export type AppContext = {
  Bindings: Bindings
  Variables: Variables
}
