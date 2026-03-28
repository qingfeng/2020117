-- Kind 30085: Agent Reputation Attestations (NIP-XX / PR #2285)
-- Parameterized replaceable: unique per (attestor_pubkey, subject_pubkey, context)
CREATE TABLE IF NOT EXISTS dvm_attestation (
  id TEXT PRIMARY KEY,
  attestor_pubkey TEXT NOT NULL,
  subject_pubkey TEXT NOT NULL,
  context TEXT NOT NULL,
  rating INTEGER NOT NULL,
  confidence REAL NOT NULL,
  evidence TEXT,
  expires_at INTEGER NOT NULL,
  nostr_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dvm_attestation_unique
  ON dvm_attestation(attestor_pubkey, subject_pubkey, context);

CREATE INDEX IF NOT EXISTS idx_dvm_attestation_subject
  ON dvm_attestation(subject_pubkey);

CREATE INDEX IF NOT EXISTS idx_dvm_attestation_expires
  ON dvm_attestation(expires_at);
