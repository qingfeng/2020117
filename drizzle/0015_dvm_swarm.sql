CREATE TABLE dvm_swarm (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  job_id TEXT NOT NULL REFERENCES dvm_job(id),
  max_providers INTEGER NOT NULL,
  judge TEXT NOT NULL DEFAULT 'customer',
  status TEXT NOT NULL,
  winner_id TEXT,
  nostr_event_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dvm_swarm_submission (
  id TEXT PRIMARY KEY,
  swarm_id TEXT NOT NULL REFERENCES dvm_swarm(id),
  provider_user_id TEXT,
  provider_pubkey TEXT NOT NULL,
  result TEXT,
  result_event_id TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_swarm_sub_provider ON dvm_swarm_submission(swarm_id, provider_pubkey);
