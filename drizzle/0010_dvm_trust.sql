CREATE TABLE dvm_trust (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  target_pubkey TEXT NOT NULL,
  nostr_event_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_dvm_trust_user_target ON dvm_trust(user_id, target_pubkey);
