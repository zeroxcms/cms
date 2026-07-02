-- Admin-approved plugin static assets (JS/CSS) allowed to execute/apply inside
-- CMS chrome. Plugins declare candidate files in their manifest ("assets"); an
-- admin must explicitly approve each one here, pinning the content hash at
-- approval time. See src/utils/plugin-assets.ts.
CREATE TABLE IF NOT EXISTS plugin_asset_approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Manifest id of the plugin that declared this asset (e.g. "checkin").
    plugin_id TEXT NOT NULL,
    -- Path relative to the plugin's own origin, e.g. "/assets/js/kiosk.js".
    path TEXT NOT NULL,
    -- SRI hash ("sha384-...") of the approved bytes, recomputed and checked on
    -- every serve — if the plugin's file changes, the approval stops matching
    -- and the asset stops being served until an admin re-approves it.
    integrity TEXT NOT NULL,
    -- Email of the admin who approved this asset (audit trail).
    approved_by TEXT NOT NULL,
    UNIQUE(plugin_id, path)
);

CREATE INDEX IF NOT EXISTS idx_plugin_asset_approvals_plugin ON plugin_asset_approvals(plugin_id);
