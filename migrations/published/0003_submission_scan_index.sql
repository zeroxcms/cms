-- Generic live-only submission ingest scans every page type in stable order.
CREATE INDEX IF NOT EXISTS idx_live_pages_created_at_uuid ON live_pages(created_at, uuid);
