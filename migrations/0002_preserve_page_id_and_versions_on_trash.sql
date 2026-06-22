-- Preserve a page's identity and history across the trash → restore cycle.
--
-- Previously a delete copied the page into trash_pages with a fresh id (only
-- the uuid was preserved) and cascade-deleted its page_versions, so a restore
-- produced a new id and an empty version history. We now carry the original id
-- and a mirror of the versions through trash, parallel to trash_page_tags.

-- 1. Remember the current-version pointer while the page sits in trash.
ALTER TABLE trash_pages ADD COLUMN current_page_version_id INTEGER;

-- 2. Mirror page_versions for trashed pages so deleting a page no longer loses
--    its history and a restore can bring every version back unchanged.
CREATE TABLE IF NOT EXISTS trash_page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trash_page_versions_page_id ON trash_page_versions(page_id);
