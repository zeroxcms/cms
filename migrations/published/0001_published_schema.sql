-- ============================================================
-- Published content schema - applied to the published-only DB
-- ============================================================

CREATE TABLE IF NOT EXISTS live_pages(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    weight INTEGER DEFAULT 5,
    start DATETIME,
    end DATETIME,
    page_type TEXT,
    lect TEXT,
    page_id INTEGER,
    creator INTEGER,
    editors TEXT
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

CREATE INDEX IF NOT EXISTS idx_live_pages_page_type_name ON live_pages(page_type, name);
CREATE INDEX IF NOT EXISTS idx_live_pages_page_type_slug ON live_pages(page_type, slug);
CREATE INDEX IF NOT EXISTS idx_live_page_tags_page_id ON live_page_tags(page_id);
CREATE INDEX IF NOT EXISTS idx_live_page_tags_tag_id ON live_page_tags(tag_id);

CREATE TRIGGER IF NOT EXISTS live_pages_updated_at AFTER UPDATE ON live_pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE live_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS live_page_tags_updated_at AFTER UPDATE ON live_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE live_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
