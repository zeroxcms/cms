-- ============================================================
-- Rename page edit metadata columns
-- Shortens creator/editor allow-list columns now that the shape is stable.
-- ============================================================

ALTER TABLE draft_pages RENAME COLUMN creator_user_id TO creator;
ALTER TABLE draft_pages RENAME COLUMN editor_user_ids TO editors;

ALTER TABLE live_pages RENAME COLUMN creator_user_id TO creator;
ALTER TABLE live_pages RENAME COLUMN editor_user_ids TO editors;

ALTER TABLE trash_pages RENAME COLUMN creator_user_id TO creator;
ALTER TABLE trash_pages RENAME COLUMN editor_user_ids TO editors;
