-- Nostr relay event storage
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  sig TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_pubkey ON events(pubkey);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind ON events(pubkey, kind, created_at);

-- Denormalized tag index for fast filter queries
CREATE TABLE IF NOT EXISTS event_tags (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL,
  tag_value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_tags_value ON event_tags(tag_name, tag_value);
CREATE INDEX IF NOT EXISTS idx_event_tags_event ON event_tags(event_id);

-- Allowed pubkeys (NeoGroup users + groups)
CREATE TABLE IF NOT EXISTS allowed_pubkeys (
  pubkey TEXT PRIMARY KEY,
  label TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
