-- Database-driven plugin registry (URL transport).
--
-- Replaces the static `PLUGINS` env var + [[services]] service bindings: each
-- row is an active plugin reached over HTTPS at `{url}/__plugin/...`. Adding a
-- plugin becomes an INSERT (via the plugin:manage admin UI) — no CMS redeploy.
-- The CMS forwards the shared PLUGIN_SECRET on privileged calls (hooks / admin /
-- publish), so plugin endpoints must enforce it; manifest/views stay public.

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
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled, sort_order);
