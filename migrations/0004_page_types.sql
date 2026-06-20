-- ============================================================
-- Database-defined page types — a runtime-editable third source
-- of content types, merged on top of cms-config.ts + plugins by
-- resolveCmsConfig(). See src/utils/page-type-store.ts.
-- ============================================================

CREATE TABLE IF NOT EXISTS page_types(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- slug: the page-type key (e.g. 'event'); becomes the blueprint map key
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    -- JSON array of BlueprintEntry for this type (required)
    blueprint TEXT NOT NULL,
    -- Optional JSON fragments merged into the effective config
    blocks TEXT,
    block_lists TEXT,
    tag_lists TEXT,
    weight INTEGER DEFAULT 5
);
