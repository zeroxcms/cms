-- ============================================================
-- Initial CMS schema — applied to the private CMS (admin) database.
-- Consolidated single migration for a clean install.
-- ============================================================

-- 1. Users – populated on first OAuth login
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oauth_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    -- role: comma-separated list of admin | editor | moderator | viewer
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 2. Sessions – stores hashed refresh tokens for revocation support
CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- 3. Taxonomies – groupings that tags belong to (e.g. Categories, Topics)
CREATE TABLE IF NOT EXISTS taxonomies(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
);

-- 4. Tags – terms within a taxonomy. Shared by draft and trash page states.
--    Supports hierarchical tags and structured lect snapshots.
CREATE TABLE IF NOT EXISTS tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    taxonomy_id INTEGER REFERENCES taxonomies(id) ON DELETE SET NULL,
    parent_tag INTEGER REFERENCES tags(id) ON DELETE SET NULL,
    lect TEXT
);

-- 5. Draft Pages
CREATE TABLE IF NOT EXISTS draft_pages(
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
    -- IANA tz name or UTC offset (e.g. 'Asia/Hong_Kong', '+0800') for start/end.
    timezone TEXT,
    page_type TEXT,
    current_page_version_id INTEGER,
    lect TEXT,
    page_id INTEGER,
    creator INTEGER,
    editors TEXT,
    FOREIGN KEY (page_id) REFERENCES draft_pages (id) ON DELETE CASCADE
);

-- 6. Trash Pages
CREATE TABLE IF NOT EXISTS trash_pages(
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
    -- IANA tz name or UTC offset (e.g. 'Asia/Hong_Kong', '+0800') for start/end.
    timezone TEXT,
    page_type TEXT,
    -- Current-version pointer preserved while the page sits in trash.
    current_page_version_id INTEGER,
    lect TEXT,
    page_id INTEGER,
    -- Original draft parent id, retained so a trashed child can be restored
    -- under a parent that remains live (page_id references another trash row).
    source_page_id INTEGER,
    creator INTEGER,
    editors TEXT,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- 7. Page Versions – supports version browsing and snapshots
CREATE TABLE IF NOT EXISTS page_versions(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER NOT NULL,
    lect TEXT,
    action TEXT,
    FOREIGN KEY (page_id) REFERENCES draft_pages (id) ON DELETE CASCADE
);

-- 8. Draft Page Tags
CREATE TABLE IF NOT EXISTS draft_page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES draft_pages (id) ON DELETE CASCADE
);

-- 9. Trash Page Tags
CREATE TABLE IF NOT EXISTS trash_page_tags(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    page_id INTEGER,
    tag_id INTEGER NOT NULL,
    weight INTEGER DEFAULT 5,
    FOREIGN KEY (page_id) REFERENCES trash_pages (id) ON DELETE CASCADE
);

-- 10. Media Files
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

-- 11. Page Types – runtime-editable content types, merged on top of
--     cms-config.ts + plugins by resolveCmsConfig(). See page-type-store.ts.
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
    -- Optional JSON arrays of names: block_lists = block-type slugs available on
    -- this page type; taxonomy_lists = taxonomy slugs shown in its editor.
    block_lists TEXT,
    taxonomy_lists TEXT,
    weight INTEGER DEFAULT 5
);

-- 12. Block Types – reusable block definitions (a named blueprint) merged into
--     config.blocks by resolveCmsConfig(). See block-type-store.ts.
CREATE TABLE IF NOT EXISTS block_types(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- slug: the block-type key (e.g. 'logos'); becomes the blocks map key
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    -- JSON array of BlueprintEntry for this block's fields (required)
    blueprint TEXT NOT NULL,
    weight INTEGER DEFAULT 5
);

-- 13. Audit log for admin mutations (who did what, when)
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,            -- e.g. 'page.create', 'page.publish', 'taxonomy.delete', 'media.upload'
    entity_type TEXT NOT NULL,       -- 'page' | 'tag' | 'taxonomy' | 'media' | ...
    entity_id TEXT,
    detail TEXT,                     -- small JSON blob (slug, filename); never content bodies
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 14. Roles – custom roles, plus built-in roles once their permissions are
--     customized. Built-in roles (admin/editor/moderator/viewer) are implicit
--     in code (USER_ROLES) and only appear here after being edited.
CREATE TABLE IF NOT EXISTS roles(
    name TEXT PRIMARY KEY,           -- slug-like role key
    label TEXT NOT NULL,
    -- 1 = a built-in role with customized permissions; 0 = a custom role
    builtin INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- 15. Role permissions – grants for any role listed in `roles`. A built-in role
--     with no override here falls back to its code default; the 'admin' role is
--     always granted every permission in code and is not stored.
CREATE TABLE IF NOT EXISTS role_permissions(
    role TEXT NOT NULL,
    permission TEXT NOT NULL,
    PRIMARY KEY (role, permission)
);

-- 16. Trash Page Versions – mirrors page_versions for trashed pages so deleting
--     a page no longer loses its history and a restore brings every version back.
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

-- 17. Plugins – database-driven plugin registry (URL transport). Each row is a
--     plugin reached over HTTPS at `{url}/__plugin/...`. The CMS forwards the
--     plugin's own `secret` (falling back to env PLUGIN_SECRET when NULL).
CREATE TABLE IF NOT EXISTS plugins(
    id INTEGER UNIQUE DEFAULT ((( strftime('%s','now') - 1563741060 ) * 100000) + (RANDOM() & 65535)) NOT NULL,
    uuid TEXT UNIQUE DEFAULT (lower(hex( randomblob(4)) || '-' || hex( randomblob(2)) || '-' || '4' || substr( hex( randomblob(2)), 2)
    || '-' || substr('AB89', 1 + (abs(random()) % 4) , 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) ) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Admin-friendly label for the manage UI (the manifest name is preferred when reachable).
    label TEXT NOT NULL DEFAULT '',
    -- Base URL; the CMS calls {url}/__plugin/manifest, /hooks/*, /admin/*, /publish/*.
    url TEXT NOT NULL UNIQUE,
    -- 1 = active (manifest resolved + content types merged); 0 = registered but inert.
    enabled INTEGER NOT NULL DEFAULT 1,
    -- Optional JSON config (reserved for forwarding plugin settings).
    config TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Per-plugin shared secret; NULL falls back to env PLUGIN_SECRET.
    secret TEXT
);

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_draft_pages_page_type_name ON draft_pages(page_type, name);
CREATE INDEX IF NOT EXISTS idx_draft_pages_page_type_slug ON draft_pages(page_type, slug);
CREATE INDEX IF NOT EXISTS idx_page_versions_page_id_created_at ON page_versions(page_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tags_taxonomy_id ON tags(taxonomy_id);
CREATE INDEX IF NOT EXISTS idx_tags_parent_tag ON tags(parent_tag);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_trash_page_versions_page_id ON trash_page_versions(page_id);
CREATE INDEX IF NOT EXISTS idx_trash_pages_source_page_id ON trash_pages(source_page_id);
CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled, sort_order);

-- ============================================================
-- Triggers for updated_at column automatic updates
-- ============================================================
CREATE TRIGGER IF NOT EXISTS users_updated_at AFTER UPDATE ON users WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS roles_updated_at AFTER UPDATE ON roles WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE roles SET updated_at = CURRENT_TIMESTAMP WHERE name = old.name;
END;

CREATE TRIGGER IF NOT EXISTS taxonomies_updated_at AFTER UPDATE ON taxonomies WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE taxonomies SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS tags_updated_at AFTER UPDATE ON tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS block_types_updated_at AFTER UPDATE ON block_types WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE block_types SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS draft_pages_updated_at AFTER UPDATE ON draft_pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE draft_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trash_pages_updated_at AFTER UPDATE ON trash_pages WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS page_versions_updated_at AFTER UPDATE ON page_versions WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE page_versions SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS draft_page_tags_updated_at AFTER UPDATE ON draft_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE draft_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trash_page_tags_updated_at AFTER UPDATE ON trash_page_tags WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE trash_page_tags SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
