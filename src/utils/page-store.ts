import type { Env } from '../types';
import { savePageVersion } from './admin-queries';

export async function savePageVersionAndSetCurrent(
  db: D1Database,
  pageId: number,
  lect: string | null,
  action: string | null,
): Promise<number> {
  const versionId = await savePageVersion(db, pageId, lect, action);
  await db.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
    .bind(versionId, pageId)
    .run();
  return versionId;
}

export async function setDraftPageTags(
  db: D1Database,
  pageId: number,
  tags: unknown,
  replace: boolean,
): Promise<void> {
  if (!Array.isArray(tags)) return;
  if (replace) {
    await db.prepare('DELETE FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .run();
  }

  for (const tagId of numericTagIds(tags)) {
    await db.prepare('INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
      .bind(pageId, tagId)
      .run();
  }
}

export async function notifyPageSaved(env: Env, pageId: number): Promise<void> {
  try {
    const id = env.PAGE_SYNC.idFromName(`page-${pageId}`);
    await env.PAGE_SYNC.get(id).fetch('https://page-sync/?action=saved', { method: 'POST' });
  } catch {
    // Sync is a non-critical overlay; never block a save on it.
  }
}

function numericTagIds(tags: unknown[]): number[] {
  return tags
    .map((tag) => Number(tag))
    .filter((tag): tag is number => Number.isFinite(tag));
}
