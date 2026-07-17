-- Recurring credit subscriptions: one row per (user, plugin, cost),
-- created/updated by plugin usage reports (POST /__cms/credits/usage) and
-- billed monthly by the cron sweep. See utils/credit-subscriptions.ts.
CREATE TABLE IF NOT EXISTS credit_subscriptions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    plugin_id TEXT NOT NULL,
    credit_key TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    peak_quantity INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled')),
    next_charge_at TEXT NOT NULL,
    last_charged_at TEXT,
    last_mode TEXT CHECK (last_mode IN ('advance', 'arrears')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, plugin_id, credit_key),
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_credit_subscriptions_due ON credit_subscriptions(status, next_charge_at);
