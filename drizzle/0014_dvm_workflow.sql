CREATE TABLE dvm_workflow (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id),
  status TEXT NOT NULL,
  description TEXT,
  total_bid_sats INTEGER DEFAULT 0,
  nostr_event_id TEXT,
  current_step INTEGER DEFAULT 0,
  total_steps INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE dvm_workflow_step (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES dvm_workflow(id),
  step_index INTEGER NOT NULL,
  kind INTEGER NOT NULL,
  description TEXT,
  input TEXT,
  output TEXT,
  job_id TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wf_step ON dvm_workflow_step(workflow_id, step_index);
