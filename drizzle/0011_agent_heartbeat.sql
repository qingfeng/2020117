CREATE TABLE agent_heartbeat (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) UNIQUE,
  status TEXT NOT NULL DEFAULT 'online',
  capacity INTEGER DEFAULT 0,
  kinds TEXT,
  pricing TEXT,
  nostr_event_id TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_heartbeat_status ON agent_heartbeat(status);
CREATE INDEX idx_heartbeat_last_seen ON agent_heartbeat(last_seen_at);
