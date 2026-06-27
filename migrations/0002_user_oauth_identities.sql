-- Multiple OAuth identities per CMS user.
-- Keeps users.oauth_id as the legacy primary identity while allowing providers
-- like Google/GitHub/Eventuai to be linked to the same user account.

CREATE TABLE IF NOT EXISTS user_oauth_identities(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    oauth_id TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    UNIQUE(provider, provider_user_id)
);

INSERT OR IGNORE INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
SELECT
    id,
    CASE
      WHEN instr(oauth_id, ':') > 0 THEN substr(oauth_id, 1, instr(oauth_id, ':') - 1)
      ELSE 'legacy'
    END,
    CASE
      WHEN instr(oauth_id, ':') > 0 THEN substr(oauth_id, instr(oauth_id, ':') + 1)
      ELSE oauth_id
    END,
    oauth_id
FROM users
WHERE oauth_id IS NOT NULL AND oauth_id != '';

CREATE INDEX IF NOT EXISTS idx_user_oauth_identities_user_id ON user_oauth_identities(user_id);

CREATE TRIGGER IF NOT EXISTS user_oauth_identities_updated_at
AFTER UPDATE ON user_oauth_identities
WHEN old.updated_at < CURRENT_TIMESTAMP
BEGIN
    UPDATE user_oauth_identities SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
