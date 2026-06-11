-- Presence moved to the page-scoped PageSyncDO Durable Object.
-- Rebuilt D1 databases should not retain a runtime presence table.
DROP TABLE IF EXISTS presence;
