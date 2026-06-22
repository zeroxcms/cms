-- Per-plugin shared secret.
--
-- Previously every plugin authenticated with one CMS-wide PLUGIN_SECRET env var,
-- so a leak (or the need to revoke one plugin) forced rotating the secret on the
-- CMS and *every* plugin at once. This column gives each registered plugin its
-- own secret: the CMS sends a plugin's own secret on hooks/admin/publish calls,
-- and the F1 write-back API checks the caller's secret against its own row — so a
-- single plugin can be rotated or invalidated independently of the others.
--
-- Nullable for a non-breaking migration: a row with NULL secret falls back to the
-- env PLUGIN_SECRET (see src/plugins/registry.ts). Rotate each plugin to a
-- dedicated secret from the admin UI, then the env var can be dropped.

ALTER TABLE plugins ADD COLUMN secret TEXT;
