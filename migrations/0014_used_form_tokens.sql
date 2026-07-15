-- Single-use form-submit tokens (double-submit protection). Rows are written
-- only when a stamped admin form is actually submitted; the UNIQUE primary key
-- is what atomically detects a duplicate POST of the same token.
CREATE TABLE IF NOT EXISTS used_form_tokens (
  token TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_used_form_tokens_used_at
ON used_form_tokens(used_at);
