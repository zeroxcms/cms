// Centralized D1 access helpers used across the admin routes.
// SQL stays raw here — this module just removes the duplication of issuing it.

import type { Page, PageVersion, PageTag, Tag, Taxonomy } from '../types';
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

/** Avatar URL for the signed-in user — replaces the avatar lookup duplicated across handlers. */
export async function fetchUserAvatar(db: D1Database, userId: number): Promise<string | null> {
  const row = await db.prepare('SELECT avatar_url FROM users WHERE id = ?')
    .bind(userId)
    .first<{ avatar_url: string | null }>();
  return row?.avatar_url ?? null;
}

/** Display name for a user id (e.g. the page's `_modifier`); null when missing or unknown. */
export async function fetchUserName(db: D1Database, userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const row = await db.prepare('SELECT name, email FROM users WHERE id = ?')
    .bind(userId)
    .first<{ name: string | null; email: string | null }>();
  if (!row) return null;
  return row.name?.trim() || row.email || null;
}

/**
 * Returns a draft-page slug guaranteed not to collide with another draft page,
 * appending `-2`, `-3`, … to the desired slug until it is free. Pass the page's
 * own id as `excludeId` on update so it doesn't collide with itself.
 */
export async function ensureUniqueDraftSlug(
  db: D1Database,
  slug: string,
  excludeId?: number,
): Promise<string> {
  let candidate = slug;
  let suffix = 2;
  while (
    await db
      .prepare('SELECT 1 FROM draft_pages WHERE slug = ? AND (? IS NULL OR id != ?) LIMIT 1')
      .bind(candidate, excludeId ?? null, excludeId ?? null)
      .first()
  ) {
    candidate = `${slug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export async function parentPageOption(db: D1Database, pageId: string | number | null | undefined): Promise<Page[]> {
  const id = num(pageId, 0);
  if (!id) return [];
  const page = await db.prepare('SELECT id, name, slug FROM draft_pages WHERE id = ?')
    .bind(id)
    .first<Page>();
  return page ? [page] : [];
}

export async function editorTaxonomy(db: D1Database): Promise<{ tags: Tag[]; taxonomies: Taxonomy[] }> {
  const [tags, taxonomies] = await Promise.all([
    db.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    db.prepare('SELECT * FROM taxonomies ORDER BY name ASC').all<Taxonomy>(),
  ]);
  return {
    tags: tags.results,
    taxonomies: taxonomies.results,
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

/**
 * Soft-deletes a draft page: copies the page, its version history, and its tag
 * links into the trash tables (preserving ids so a restore keeps identity),
 * then removes it from `draft_pages`. Returns the page that was trashed, or
 * null when no such page exists. Callers remain responsible for unpublishing
 * and firing the `delete` lifecycle hook — this is the DB-copy half only, shared
 * by the admin delete handler and the plugin write-back API so the trash schema
 * lives in exactly one place.
 */
export async function trashDraftPage(db: D1Database, pageId: number): Promise<Page | null> {
  const page = await db.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return null;

  await db.prepare(
    `INSERT INTO trash_pages (id, uuid, name, slug, weight, start, end, page_type, current_page_version_id, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       current_page_version_id = excluded.current_page_version_id,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      page.id,
      page.uuid,
      page.name,
      page.slug,
      page.weight,
      page.start,
      page.end,
      page.page_type,
      page.current_page_version_id ?? null,
      page.lect,
      page.page_id,
      page.creator,
      page.editors,
    )
    .run();

  const trashPage = await db.prepare('SELECT id FROM trash_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();

  if (trashPage) {
    const pageVersions = await db.prepare('SELECT * FROM page_versions WHERE page_id = ?')
      .bind(pageId)
      .all<PageVersion>();
    for (const version of pageVersions.results) {
      await db.prepare(
        `INSERT OR IGNORE INTO trash_page_versions (id, uuid, created_at, page_id, lect, action)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(version.id, version.uuid, version.created_at, trashPage.id, version.lect, version.action)
        .run();
    }

    const pageTags = await db.prepare('SELECT * FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<PageTag>();
    for (const pt of pageTags.results) {
      await db.prepare(
        `INSERT OR IGNORE INTO trash_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, trashPage.id, pt.tag_id, pt.weight)
        .run();
    }
  }

  await db.prepare('DELETE FROM draft_pages WHERE id = ?').bind(pageId).run();
  return page;
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

