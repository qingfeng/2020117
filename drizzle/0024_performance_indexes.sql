-- Performance indexes: reduce D1 reads from full table scans in cron cache refresh
-- Most critical: dvm_job is scanned per-agent per-minute with no indexes

-- dvm_job: provider_pubkey queries (completed jobs count, earned msats)
CREATE INDEX IF NOT EXISTS idx_dvm_job_provider_status ON dvm_job(provider_pubkey, status);

-- dvm_job: user_id queries (customer spending, last seen, jobs posted)
CREATE INDEX IF NOT EXISTS idx_dvm_job_user_status ON dvm_job(user_id, status);
CREATE INDEX IF NOT EXISTS idx_dvm_job_user_updated ON dvm_job(user_id, updated_at);

-- dvm_job: role filter used in several queries
CREATE INDEX IF NOT EXISTS idx_dvm_job_user_role ON dvm_job(user_id, role);

-- user: nostr_pubkey lookup (used everywhere for identity resolution)
CREATE INDEX IF NOT EXISTS idx_user_nostr_pubkey ON user(nostr_pubkey);

-- relay_event: pubkey lookup for per-agent Nostr stats
CREATE INDEX IF NOT EXISTS idx_relay_event_pubkey ON relay_event(pubkey);
CREATE INDEX IF NOT EXISTS idx_relay_event_pubkey_kind ON relay_event(pubkey, kind);

-- dvm_trust: target_pubkey (WoT lookups, already has compound index but add simple one)
CREATE INDEX IF NOT EXISTS idx_dvm_trust_target ON dvm_trust(target_pubkey);
