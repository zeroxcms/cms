-- ============================================================
-- Auth schema - applied to the CMS database
-- ============================================================

-- Users – populated on first OAuth login
CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    oauth_id TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    -- role: comma-separated list of admin | editor | moderator | viewer
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Sessions – stores hashed refresh tokens for revocation support
CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    refresh_token_hash TEXT UNIQUE NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP NOT NULL ,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS users_updated_at AFTER UPDATE ON users WHEN old.updated_at < CURRENT_TIMESTAMP BEGIN
    UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = old.id;
END;
