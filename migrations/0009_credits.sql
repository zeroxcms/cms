-- Credit system: per-user balance plus an append-only ledger of every change.
-- The balance column is the fast path used by charge checks; the ledger is the
-- audit trail shown on the profile page. Both are written in one DB.batch so
-- they cannot drift.
ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS credit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    -- negative = spend, positive = grant / refund / admin adjustment
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    -- e.g. 'events:create_guest_list', 'page_create:batch', 'admin:adjust'
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    plugin_id TEXT,
    note TEXT,
    -- who triggered it: a user id, or 'plugin:<id>' for server-to-server writes
    created_by TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger (user_id, id DESC);
