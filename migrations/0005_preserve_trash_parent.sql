-- A trashed child cannot retain its live parent's id in `trash_pages.page_id`,
-- because that column references another trashed page. Keep the original draft
-- parent separately so the child can be restored under a parent that remains live.
ALTER TABLE trash_pages ADD COLUMN source_page_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_trash_pages_source_page_id ON trash_pages(source_page_id);
