-- ============================================================
-- Content schema – applied to TRASH database
-- Identical to draft/0001_content_schema.sql and live/0001_content_schema.sql
-- ============================================================

-- Tags reference table
CREATE TABLE IF NOT EXISTS tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL ,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL ,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    name TEXT NOT NULL ,
    slug TEXT NOT NULL UNIQUE
);

-- Pages table (hierarchical, self-referencing)
CREATE TABLE IF NOT EXISTS pages(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL ,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL ,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    name TEXT NOT NULL ,
    slug TEXT NOT NULL ,
    weight INTEGER DEFAULT 5 ,
    start DATETIME ,
    end DATETIME ,
    page_type TEXT ,
    current_page_version_id INTEGER ,
    original TEXT ,
    page_id INTEGER ,
    FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
);

-- Page versions – stores the actual content of each page revision
CREATE TABLE IF NOT EXISTS page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL ,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL ,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    page_id INTEGER NOT NULL ,
    content TEXT ,
    meta TEXT ,
    FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
);

-- Page-tag relationships
CREATE TABLE IF NOT EXISTS page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL ,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL ,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    page_id INTEGER ,
    tag_id INTEGER NOT NULL ,
    weight INTEGER DEFAULT 5 ,
    FOREIGN KEY (page_id) REFERENCES pages (id) ON DELETE CASCADE
);

-- Auto-update triggers
CREATE TRIGGER IF NOT EXISTS tags_updated_at AFTER UPDATE ON tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS pages_updated_at AFTER UPDATE ON pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_versions_updated_at AFTER UPDATE ON page_versions WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_versions SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_tags_updated_at AFTER UPDATE ON page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
