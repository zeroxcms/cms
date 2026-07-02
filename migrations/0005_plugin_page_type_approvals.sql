-- Admin-approved delegated plugin page-type access. Plugins declare candidate
-- read/write access in manifest contentTypes.readTypes/writeTypes; an admin must
-- explicitly approve each access row here before the /__cms API honors it.
CREATE TABLE IF NOT EXISTS plugin_page_type_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Manifest id of the plugin that declared this access (e.g. "checkin").
    plugin_id TEXT NOT NULL,
    -- Page type slug, e.g. "guest".
    page_type TEXT NOT NULL,
    -- Delegated access kind: "read" or "write".
    access TEXT NOT NULL CHECK(access IN ('read', 'write')),
    -- Email of the admin who approved this access (audit trail).
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, page_type, access)
);

CREATE INDEX IF NOT EXISTS idx_plugin_page_type_approvals_plugin ON plugin_page_type_approvals(plugin_id);
