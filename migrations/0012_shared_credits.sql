-- Shared credit pool: one site-wide balance that covers a spend when the
-- acting user's own balance cannot, plus its own append-only ledger. The
-- single-row table mirrors users.credits (fast-path balance + guard column);
-- the ledger mirrors credit_ledger with user_id repurposed as the beneficiary
-- (the user the pool paid for or transferred to; NULL for admin top-ups).
CREATE TABLE IF NOT EXISTS shared_credits(
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO shared_credits (id, balance) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS shared_credit_ledger(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- negative = spend / transfer out, positive = top-up / refund
    delta INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    -- e.g. 'events:create_event', 'shared:send', 'admin:adjust'
    action TEXT NOT NULL,
    -- the user the pool paid for or sent credits to; NULL for pool top-ups
    user_id INTEGER,
    entity_type TEXT,
    entity_id TEXT,
    plugin_id TEXT,
    note TEXT,
    -- who triggered it: a user id, or 'plugin:<id>' for server-to-server writes
    created_by TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_credit_ledger_user ON shared_credit_ledger (user_id, id DESC);
