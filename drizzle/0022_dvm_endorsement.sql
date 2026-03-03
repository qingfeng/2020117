CREATE TABLE dvm_endorsement (
  id TEXT PRIMARY KEY,
  endorser_pubkey TEXT NOT NULL,
  target_pubkey TEXT NOT NULL,
  rating INTEGER,
  comment TEXT,
  context TEXT,
  nostr_event_id TEXT,
  event_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_endorsement_pair ON dvm_endorsement(endorser_pubkey, target_pubkey);
