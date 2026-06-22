// ============================================================
// Database-driven plugin registry storage.
//
// A row in `plugins` is an active plugin Worker reached over HTTPS at
// `{url}/__plugin/...` (URL transport — see src/plugins/registry.ts). This
// replaces the static `PLUGINS` env var, so plugins are added/enabled/disabled
// from the admin UI (plugin:manage) with no CMS redeploy.
//
// All reads tolerate a missing `plugins` table (pre-migration / tests) by
// returning empty, keeping zero-plugin installs working unchanged.
// ============================================================

import type { PluginRecord } from '../types';

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugins/i.test(error.message);
}

/** Every registered plugin (enabled or not), ordered for display. */
export async function listPlugins(db: D1Database): Promise<PluginRecord[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugins ORDER BY sort_order ASC, id ASC')
      .all<PluginRecord>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

/** Active plugins only — the set the registry resolves and merges. */
export async function listEnabledPlugins(db: D1Database): Promise<PluginRecord[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugins WHERE enabled = 1 ORDER BY sort_order ASC, id ASC')
      .all<PluginRecord>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getPlugin(db: D1Database, id: number): Promise<PluginRecord | null> {
  return db.prepare('SELECT * FROM plugins WHERE id = ?').bind(id).first<PluginRecord>();
}

export interface PluginInput {
  label: string;
  url: string;
  enabled: boolean;
  config?: string | null;
  sort_order?: number;
}

/** Inserts a plugin. Returns an error message (e.g. duplicate URL) or null. */
export async function createPlugin(db: D1Database, input: PluginInput): Promise<string | null> {
  try {
    await db
      .prepare('INSERT INTO plugins (label, url, enabled, config, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(input.label, input.url, input.enabled ? 1 : 0, input.config ?? null, input.sort_order ?? 0)
      .run();
    return null;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return 'A plugin with that URL is already registered.';
    }
    throw error;
  }
}

/** Updates a plugin. Returns an error message or null. */
export async function updatePlugin(db: D1Database, id: number, input: PluginInput): Promise<string | null> {
  try {
    await db
      .prepare(
        'UPDATE plugins SET label = ?, url = ?, enabled = ?, config = ?, sort_order = ?, '
        + "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .bind(input.label, input.url, input.enabled ? 1 : 0, input.config ?? null, input.sort_order ?? 0, id)
      .run();
    return null;
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return 'A plugin with that URL is already registered.';
    }
    throw error;
  }
}

export async function setPluginEnabled(db: D1Database, id: number, enabled: boolean): Promise<void> {
  await db
    .prepare('UPDATE plugins SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(enabled ? 1 : 0, id)
    .run();
}

export async function deletePlugin(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM plugins WHERE id = ?').bind(id).run();
}
