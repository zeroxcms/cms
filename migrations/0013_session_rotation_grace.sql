-- Keep the immediately previous refresh-token hash briefly so simultaneous
-- admin requests do not mistake normal token rotation for session revocation.
ALTER TABLE sessions ADD COLUMN previous_refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotated_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_sessions_previous_refresh
ON sessions(previous_refresh_token_hash);
