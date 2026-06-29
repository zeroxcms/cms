CREATE TABLE IF NOT EXISTS admin_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('plugin_admin_action')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  plugin_id TEXT,
  method TEXT,
  path TEXT,
  content_type TEXT,
  body TEXT,
  user_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_status INTEGER,
  result_location TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_status_updated
  ON admin_jobs (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_admin_jobs_plugin_created
  ON admin_jobs (plugin_id, created_at);
