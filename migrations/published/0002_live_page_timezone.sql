-- Carry the page-level timezone annotation through to the published database.
-- Stores an IANA tz name (e.g. 'Asia/Hong_Kong'); NULL means unspecified.
ALTER TABLE live_pages ADD COLUMN timezone TEXT;
