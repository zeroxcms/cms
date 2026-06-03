-- ============================================================
-- Admin CMS parity schema
-- Adds LionRock-style tag types, structured lect snapshots, live tag
-- copies, version browsing, and media metadata.
-- ============================================================

CREATE TABLE IF NOT EXISTS tag_types(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
);

ALTER TABLE tags ADD COLUMN tag_type_id INTEGER REFERENCES tag_types(id) ON DELETE SET NULL;
ALTER TABLE tags ADD COLUMN parent_tag INTEGER REFERENCES tags(id) ON DELETE SET NULL;
ALTER TABLE tags ADD COLUMN lect TEXT;

ALTER TABLE draft_page_versions ADD COLUMN lect TEXT;
ALTER TABLE draft_page_versions ADD COLUMN action TEXT;
ALTER TABLE trash_page_versions ADD COLUMN lect TEXT;
ALTER TABLE trash_page_versions ADD COLUMN action TEXT;

ALTER TABLE live_pages ADD COLUMN current_page_version_id INTEGER;

CREATE TABLE IF NOT EXISTS live_page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES live_pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS live_page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES live_pages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_files(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    key TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT,
    size INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_draft_pages_page_type_name ON draft_pages(page_type, name);
CREATE INDEX IF NOT EXISTS idx_draft_pages_page_type_slug ON draft_pages(page_type, slug);
CREATE INDEX IF NOT EXISTS idx_draft_page_versions_page_id_created_at ON draft_page_versions(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_page_tags_page_id ON live_page_tags(page_id);
CREATE INDEX IF NOT EXISTS idx_live_page_tags_tag_id ON live_page_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag_type_id ON tags(tag_type_id);
CREATE INDEX IF NOT EXISTS idx_tags_parent_tag ON tags(parent_tag);

CREATE TRIGGER IF NOT EXISTS tag_types_updated_at AFTER UPDATE ON tag_types WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE tag_types SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS live_page_versions_updated_at AFTER UPDATE ON live_page_versions WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE live_page_versions SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS live_page_tags_updated_at AFTER UPDATE ON live_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE live_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
