// ============================================================
// Admin-approved plugin static assets (JS/CSS) — see PluginManifest.assets.
//
// A plugin manifest only *declares* candidate files; nothing runs until an
// admin explicitly approves a path here, which pins the file's content hash
// (SRI, "sha384-..."). Every serve re-fetches the plugin's file and recomputes
// the hash — if it no longer matches the approval, the asset is treated as
// unapproved (fail closed) rather than served stale-trusted.
// ============================================================

import type { PluginAssetApproval } from '../types';

function missingTable(error: unknown): boolean {
  return error instanceof Error && /no such table: plugin_asset_approvals/i.test(error.message);
}

/** All approvals for a plugin, ordered by path. */
export async function listApprovals(db: D1DatabaseClient, pluginId: string): Promise<PluginAssetApproval[]> {
  try {
    const { results } = await db
      .prepare('SELECT * FROM plugin_asset_approvals WHERE plugin_id = ? ORDER BY path ASC')
      .bind(pluginId)
      .all<PluginAssetApproval>();
    return results;
  } catch (error) {
    if (missingTable(error)) return [];
    throw error;
  }
}

export async function getAssetApproval(db: D1DatabaseClient, pluginId: string, path: string): Promise<PluginAssetApproval | null> {
  try {
    return await db
      .prepare('SELECT * FROM plugin_asset_approvals WHERE plugin_id = ? AND path = ?')
      .bind(pluginId, path)
      .first<PluginAssetApproval>();
  } catch (error) {
    if (missingTable(error)) return null;
    throw error;
  }
}

/** Approves (or re-approves) a plugin asset, pinning the given integrity hash. */
export async function approveAsset(
  db: D1DatabaseClient,
  pluginId: string,
  path: string,
  integrity: string,
  approvedBy: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO plugin_asset_approvals (plugin_id, path, integrity, approved_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(plugin_id, path) DO UPDATE SET
         integrity = excluded.integrity,
         approved_by = excluded.approved_by,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(pluginId, path, integrity, approvedBy)
    .run();
}

export async function revokeAsset(db: D1DatabaseClient, pluginId: string, path: string): Promise<void> {
  await db.prepare('DELETE FROM plugin_asset_approvals WHERE plugin_id = ? AND path = ?').bind(pluginId, path).run();
}

/** SRI-format digest ("sha384-<base64>") of the given bytes. */
export async function computeIntegrity(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-384', bytes);
  return `sha384-${base64(digest)}`;
}

function base64(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
