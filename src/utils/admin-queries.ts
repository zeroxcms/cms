// Centralized D1 access helpers used across the admin routes.
// SQL stays raw here — this module just removes the duplication of issuing it.

import type { Page, Tag, Taxonomy } from '../types';
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

