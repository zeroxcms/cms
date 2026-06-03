-- ============================================================
-- Page edit metadata
-- Stores page ownership and explicit editor allow-lists outside lect.
-- ============================================================

ALTER TABLE draft_pages ADD COLUMN creator_user_id INTEGER;
ALTER TABLE draft_pages ADD COLUMN editor_user_ids TEXT;

ALTER TABLE live_pages ADD COLUMN creator_user_id INTEGER;
ALTER TABLE live_pages ADD COLUMN editor_user_ids TEXT;

ALTER TABLE trash_pages ADD COLUMN creator_user_id INTEGER;
ALTER TABLE trash_pages ADD COLUMN editor_user_ids TEXT;
