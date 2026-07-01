import type { Env } from '../types';
import type { Page, PageTag } from '../types';
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

export interface PullPublishedPageResult {
  page: Page;
  created: boolean;
}

export async function pullPublishedPageToDraft(
  draftDb: D1Database,
  publishedDb: D1Database,
  uuid: string,
): Promise<PullPublishedPageResult | null> {
  const existing = await draftDb.prepare('SELECT * FROM draft_pages WHERE uuid = ?')
    .bind(uuid)
    .first<Page>();
  if (existing) return { page: existing, created: false };

  const livePage = await publishedDb.prepare('SELECT * FROM live_pages WHERE uuid = ?')
    .bind(uuid)
    .first<Page>();
  if (!livePage) return null;

  const parentId = await existingDraftParentId(draftDb, livePage.page_id);
  await draftDb.prepare(
    `INSERT INTO draft_pages (uuid, created_at, updated_at, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      livePage.uuid,
      livePage.created_at,
      livePage.updated_at,
      livePage.name,
      livePage.slug,
      livePage.weight,
      livePage.start,
      livePage.end,
      livePage.timezone,
      livePage.page_type,
      livePage.lect,
      parentId,
      livePage.creator,
      livePage.editors,
    )
    .run();

  const draftPage = await draftDb.prepare('SELECT * FROM draft_pages WHERE uuid = ?')
    .bind(uuid)
    .first<Page>();
  if (!draftPage) return null;

  await copyPublishedTagsToDraft(draftDb, publishedDb, livePage.id, draftPage.id);
  await savePageVersionAndSetCurrent(draftDb, draftPage.id, livePage.lect, 'pull-published');

  const pulledPage = await draftDb.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(draftPage.id)
    .first<Page>();
  return { page: pulledPage ?? draftPage, created: true };
}

function numericTagIds(tags: unknown[]): number[] {
  return tags
    .map((tag) => Number(tag))
    .filter((tag): tag is number => Number.isFinite(tag));
}

async function existingDraftParentId(db: D1Database, parentId: number | null): Promise<number | null> {
  if (!parentId) return null;
  const parent = await db.prepare('SELECT id FROM draft_pages WHERE id = ?')
    .bind(parentId)
    .first<{ id: number }>();
  return parent?.id ?? null;
}

async function copyPublishedTagsToDraft(
  draftDb: D1Database,
  publishedDb: D1Database,
  livePageId: number,
  draftPageId: number,
): Promise<void> {
  const tags = await publishedDb.prepare(
    'SELECT uuid, tag_id, weight FROM live_page_tags WHERE page_id = ? ORDER BY weight ASC, id ASC',
  )
    .bind(livePageId)
    .all<Pick<PageTag, 'uuid' | 'tag_id' | 'weight'>>();

  for (const tag of tags.results) {
    await draftDb.prepare(
      'INSERT OR IGNORE INTO draft_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind(tag.uuid, draftPageId, tag.tag_id, tag.weight)
      .run();
  }
}
