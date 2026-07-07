-- ============================================================
-- RSVP submission indexes — worker-rsvp inserts rsvp_response /
-- rsvp_registration rows into live_pages (negative ids, own uuids;
-- see src/publish/README.md). These serve its "latest response for
-- guest N" lookup and the host's ingest scan of new submissions.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_live_pages_page_type_page_id ON live_pages(page_type, page_id);
CREATE INDEX IF NOT EXISTS idx_live_pages_page_type_created_at ON live_pages(page_type, created_at);
