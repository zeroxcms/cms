CREATE TABLE IF NOT EXISTS presence (
  user_id     TEXT    NOT NULL,
  user_name   TEXT    NOT NULL,
  user_avatar TEXT,
  page_id     INTEGER NOT NULL,
  last_seen   TEXT    NOT NULL,
  last_active TEXT    NOT NULL,
  PRIMARY KEY (user_id, page_id)
);
