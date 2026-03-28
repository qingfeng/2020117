-- Add ref_event_id column to relay_event for fast indexed lookups
-- Stores the first 'e' tag value (referenced event ID) for replies/reactions/reposts
ALTER TABLE relay_event ADD COLUMN `ref_event_id` text;

-- Index for fast "find all replies/reactions/reposts to event X" queries
CREATE INDEX IF NOT EXISTS idx_relay_event_kind_ref ON relay_event(kind, ref_event_id);
CREATE INDEX IF NOT EXISTS idx_relay_event_ref_id ON relay_event(ref_event_id);

-- Also add (kind, event_created_at) for timeline pagination
CREATE INDEX IF NOT EXISTS idx_relay_event_kind_created ON relay_event(kind, event_created_at);

-- Backfill ref_event_id from existing tags JSON
UPDATE relay_event SET ref_event_id = json_extract(tags, '$.e') WHERE ref_event_id IS NULL AND tags IS NOT NULL AND json_extract(tags, '$.e') IS NOT NULL;
