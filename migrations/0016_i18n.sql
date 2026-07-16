CREATE TABLE locales (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  content_enabled INTEGER NOT NULL DEFAULT 1 CHECK (content_enabled IN (0, 1)),
  ui_enabled INTEGER NOT NULL DEFAULT 0 CHECK (ui_enabled IN (0, 1)),
  direction TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
  fallback_code TEXT REFERENCES locales(code) ON DELETE SET NULL,
  weight INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO locales (code, label, content_enabled, ui_enabled, direction, fallback_code, weight, builtin) VALUES
  ('mis', 'Unspecified language', 1, 0, 'ltr', NULL, 0, 1),
  ('en', 'English', 1, 1, 'ltr', NULL, 10, 1),
  ('zh-hant', '繁體中文', 1, 1, 'ltr', 'en', 20, 1),
  ('zh-hans', '简体中文', 1, 1, 'ltr', 'en', 30, 1);

CREATE TABLE locale_messages (
  locale_code TEXT NOT NULL REFERENCES locales(code) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (locale_code, message_key)
);

CREATE INDEX idx_locales_content ON locales(content_enabled, weight, code);
CREATE INDEX idx_locales_ui ON locales(ui_enabled, weight, code);
CREATE INDEX idx_locale_messages_locale ON locale_messages(locale_code, message_key);

CREATE TRIGGER locales_updated_at
AFTER UPDATE ON locales
BEGIN
  UPDATE locales SET updated_at = CURRENT_TIMESTAMP WHERE code = NEW.code;
END;

CREATE TRIGGER locale_messages_updated_at
AFTER UPDATE ON locale_messages
BEGIN
  UPDATE locale_messages
  SET updated_at = CURRENT_TIMESTAMP
  WHERE locale_code = NEW.locale_code AND message_key = NEW.message_key;
END;
