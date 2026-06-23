-- Add a page-level timezone annotation for the start/end scheduling window.
-- Stores an IANA tz name (e.g. 'Asia/Hong_Kong'); NULL means unspecified.
ALTER TABLE draft_pages ADD COLUMN timezone TEXT;
ALTER TABLE trash_pages ADD COLUMN timezone TEXT;
