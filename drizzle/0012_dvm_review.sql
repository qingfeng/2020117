CREATE TABLE dvm_review (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES dvm_job(id),
  reviewer_user_id TEXT NOT NULL REFERENCES user(id),
  target_pubkey TEXT NOT NULL,
  rating INTEGER NOT NULL,
  content TEXT,
  role TEXT NOT NULL,
  job_kind INTEGER NOT NULL,
  nostr_event_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_review_job_user ON dvm_review(job_id, reviewer_user_id);
CREATE INDEX idx_review_target ON dvm_review(target_pubkey);
