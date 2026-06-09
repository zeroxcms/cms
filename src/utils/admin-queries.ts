// Centralized D1 access helpers used across the admin routes.
// SQL stays raw here — this module just removes the duplication of issuing it.

import type { Page, PageTag, Tag, TagType } from '../types';
import { num } from './forms';

export interface DashboardListResult {
  results: Page[];
  pagination: {
    total: number;
    totalPages: number;
    currentPage: number;
    limit: number;
  };
}

export interface LivePageSnapshot {
  uuid: string;
  lect: string | null;
  weight: number;
}

/** Avatar URL for the signed-in user — replaces the avatar lookup duplicated across handlers. */
export async function fetchUserAvatar(db: D1Database, userId: number): Promise<string | null> {
  const row = await db.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(userId)
    .first<{ avatar_url: string | null }>();
  return row?.avatar_url ?? null;
}

export async function parentPageOption(db: D1Database, pageId: string | number | null | undefined): Promise<Page[]> {
  const id = num(pageId, 0);
  if (!id) return [];
  const page = await db.prepare('SELECT id, name, slug FROM draft_pages WHERE id = ?')
    .bind(id)
    .first<Page>();
  return page ? [page] : [];
}

export async function editorTaxonomy(db: D1Database): Promise<{ tags: Tag[]; tagTypes: TagType[] }> {
  const [tags, tagTypes] = await Promise.all([
    db.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    db.prepare('SELECT * FROM tag_types ORDER BY name ASC').all<TagType>(),
  ]);
  return {
    tags: tags.results,
    tagTypes: tagTypes.results,
  };
}

export async function savePageVersion(
  db: D1Database,
  pageId: number,
  lect: string | null,
  action: string | null,
): Promise<number> {
  const result = await db.prepare(
    `INSERT INTO page_versions (page_id, lect, action) VALUES (?, ?, ?)`,
  )
    .bind(pageId, lect, action)
    .run();
  const row = await db.prepare('SELECT id FROM page_versions WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  return row!.id;
}

export async function publishPage(draftDb: D1Database, publishedDb: D1Database, pageId: number): Promise<boolean> {
  const page = await draftDb.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return false;

  await publishedDb.prepare(
    `INSERT INTO live_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      page.uuid,
      page.name,
      page.slug,
      page.weight,
      page.start,
      page.end,
      page.page_type,
      page.lect,
      page.page_id,
      page.creator,
      page.editors,
    )
    .run();

  const livePage = await publishedDb.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();
  if (!livePage) return true;

  await publishedDb.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();

  const pageTags = await draftDb.prepare('SELECT * FROM draft_page_tags WHERE page_id = ?')
    .bind(pageId)
    .all<PageTag>();
  for (const pageTag of pageTags.results) {
    await publishedDb.prepare(
      'INSERT INTO live_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)',
    )
      .bind(pageTag.uuid, livePage.id, pageTag.tag_id, pageTag.weight)
      .run();
  }

  return true;
}

export async function unpublishPage(publishedDb: D1Database, pageUuid: string): Promise<void> {
  const livePage = await publishedDb.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(pageUuid)
    .first<{ id: number }>();
  if (livePage) {
    await publishedDb.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();
  }

  await publishedDb.prepare('DELETE FROM live_pages WHERE uuid = ?')
    .bind(pageUuid)
    .run();
}

export async function listDashboardDraftPages(
  db: D1Database,
  options: { pageType?: string; page: number; limit: number },
): Promise<DashboardListResult> {
  const whereSql = options.pageType ? 'WHERE page_type = ?' : '';
  const baseParams = options.pageType ? [options.pageType] : [];
  const countRow = await db.prepare(`SELECT COUNT(*) AS total FROM draft_pages ${whereSql}`)
    .bind(...baseParams)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / options.limit));
  const currentPage = Math.min(options.page, totalPages);
  const currentOffset = (currentPage - 1) * options.limit;

  const pages = await db.prepare(
    `SELECT * FROM draft_pages ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, options.limit, currentOffset)
    .all<Page>();

  return {
    results: pages.results,
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: options.limit,
    },
  };
}

export async function liveMapForDraftPages(publishedDb: D1Database, draftPages: Page[]): Promise<Map<string, LivePageSnapshot>> {
  const uuids = Array.from(new Set(draftPages.map((page) => page.uuid)));
  if (!uuids.length) return new Map();

  const placeholders = uuids.map(() => '?').join(',');
  const livePages = await publishedDb.prepare(
    `SELECT uuid, lect, weight FROM live_pages WHERE uuid IN (${placeholders})`,
  )
    .bind(...uuids)
    .all<LivePageSnapshot>();

  return new Map(livePages.results.map((page) => [page.uuid, page]));
}
