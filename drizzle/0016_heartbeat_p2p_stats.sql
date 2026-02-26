-- Add p2p_stats JSON column to agent_heartbeat
ALTER TABLE agent_heartbeat ADD COLUMN p2p_stats TEXT;
