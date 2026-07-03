// Trash listing, restore-to-draft, and permanent delete.

import { Hono } from 'hono';
import { trashPage } from '../../templates/trash';
import type { Env, Variables, Page, PageTag, PageVersion } from '../../types';
import { restoreTrashedPages, savePageVersion } from '../../utils/admin-queries';
import { dashboardPagination, renderPage, userCan } from '../../utils/admin-render';
import { dashboardPageNumber, dashboardPageSize } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';

export const trashRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Trash list ────────────────────────────────────────────────────────────────

trashRoutes.get('/trash', async (c) => {
  const flash = c.req.query('flash') ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));
  // Active type filter (the dropdown). Empty = all types.
  const filterType = c.req.query('type')?.trim() || '';
  const typeWhere = filterType ? 'WHERE page_type = ?' : '';
  const typeParams = filterType ? [filterType] : [];

  const [countRow, typeRows, recentRow] = await Promise.all([
    // Listing total/recent are scoped to the filter; the type breakdown is not,
    // so the dropdown always lists every type with its full count.
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM trash_pages ${typeWhere}`).bind(...typeParams).first<{ total: number }>(),
    c.env.DB.prepare(
      'SELECT page_type, COUNT(*) AS cnt FROM trash_pages GROUP BY page_type ORDER BY cnt DESC',
    ).all<{ page_type: string | null; cnt: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM trash_pages WHERE created_at >= datetime('now', '-1 hour') ${filterType ? 'AND page_type = ?' : ''}`,
    ).bind(...typeParams).first<{ cnt: number }>(),
  ]);

  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const trashedPages = await c.env.DB.prepare(
    `SELECT * FROM trash_pages ${typeWhere} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
  ).bind(...typeParams, pageSize, offset).all<Page>();

  const paginationResult = {
    results: trashedPages.results,
    pagination: { total, totalPages, currentPage, limit: pageSize },
  };
  const pagination = dashboardPagination('/admin/trash', paginationResult);
  // Carry the active type filter across page links.
  if (filterType) {
    const suffix = `&type=${encodeURIComponent(filterType)}`;
    for (const key of ['firstHref', 'previousHref', 'nextHref', 'lastHref'] as const) {
      if (pagination[key]) pagination[key] += suffix;
    }
  }

  const typeCounts = typeRows.results.map((r) => ({ pageType: r.page_type ?? 'unknown', count: r.cnt }));
  const grandTotal = typeCounts.reduce((sum, t) => sum + t.count, 0);

  return renderPage(c, trashPage, {
    pages: trashedPages.results,
    flash: flash || undefined,
    pagination,
    total,
    grandTotal,
    filterType,
    typeCounts,
    recentCount: recentRow?.cnt ?? 0,
    canPurgeTrash: await userCan(c, 'trash:purge'),
  });
});

// ── Restore page from trash → draft ──────────────────────────────────────────

trashRoutes.post('/trash/:id/restore', requirePermission('trash:restore'), async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);

  const trashedPage = await c.env.DB.prepare('SELECT * FROM trash_pages WHERE id = ?')
    .bind(trashId)
    .first<Page>();
  if (!trashedPage) return c.notFound();

  const originalParentId = trashedPage.source_page_id ?? trashedPage.page_id;
  const draftParent = originalParentId == null
    ? null
    : await c.env.DB.prepare('SELECT id FROM draft_pages WHERE id = ?').bind(originalParentId).first<{ id: number }>();
  const restoredParentId = draftParent?.id ?? null;

  // Restore into draft, preserving the original id and current-version pointer
  // so the page keeps the same identity it had before being trashed.
  await c.env.DB.prepare(
    `INSERT INTO draft_pages (id, uuid, name, slug, weight, start, end, timezone, page_type, current_page_version_id, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       timezone = excluded.timezone,
       page_type = excluded.page_type,
       current_page_version_id = excluded.current_page_version_id,
       lect = excluded.lect,
       page_id = excluded.page_id,
       creator = excluded.creator,
       editors = excluded.editors`,
  )
    .bind(
      trashedPage.id,
      trashedPage.uuid,
      trashedPage.name,
      trashedPage.slug,
      trashedPage.weight,
      trashedPage.start,
      trashedPage.end,
      trashedPage.timezone,
      trashedPage.page_type,
      trashedPage.current_page_version_id ?? null,
      trashedPage.lect,
      restoredParentId,
      trashedPage.creator,
      trashedPage.editors,
    )
    .run();

  const draftPage = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE uuid = ?')
    .bind(trashedPage.uuid)
    .first<{ id: number }>();

  if (draftPage) {
    // Bring version history back, preserving version ids so the restored
    // current_page_version_id still resolves to the right snapshot.
    const trashVersions = await c.env.DB.prepare('SELECT * FROM trash_page_versions WHERE page_id = ?')
      .bind(trashId)
      .all<PageVersion>();
    for (const version of trashVersions.results) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO page_versions (id, uuid, created_at, page_id, lect, action)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(version.id, version.uuid, version.created_at, draftPage.id, version.lect, version.action)
        .run();
    }

    // Restore page tags to draft
    const trashTags = await c.env.DB.prepare('SELECT * FROM trash_page_tags WHERE page_id = ?')
      .bind(trashId)
      .all<PageTag>();
    for (const pt of trashTags.results) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO draft_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, draftPage.id, pt.tag_id, pt.weight)
        .run();
    }

    // Legacy trash rows (deleted before history was preserved) carry no versions
    // or current pointer — give those a fresh restore snapshot instead.
    if (trashVersions.results.length === 0 || trashedPage.current_page_version_id == null) {
      const restoredVersionId = await savePageVersion(
        c.env.DB,
        draftPage.id,
        trashedPage.lect,
        'restore',
      );
      await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
        .bind(restoredVersionId, draftPage.id)
        .run();
    }
  }

  // Remove from TRASH
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();

  logAudit(c, 'page.restore', 'page', draftPage?.id ?? trashedPage.uuid, {
    name: trashedPage.name,
    slug: trashedPage.slug,
  });
  return c.redirect('/admin/trash?flash=Page+restored+to+draft');
});

// ── Bulk restore (all, by type, or last-hour only) ───────────────────────────
// Accepts optional form fields:
//   type   — page type to restore (empty = all types)
//   action — "now" (default) restore all matching; "1h" restore only those
//            trashed within the last hour
// Set-based so a large trash (e.g. an event's worth of guests) restores without
// the per-page route's per-row work timing out.

trashRoutes.post('/trash/restore', requirePermission('trash:restore'), async (c) => {
  const form = await c.req.formData();
  const pageType = (form.get('type') as string | null)?.trim() || null;
  const withinLastHour = (form.get('action') as string | null)?.trim() === '1h';

  const count = await restoreTrashedPages(c.env.DB, { pageType, withinLastHour });
  logAudit(c, 'page.restore_all', 'page', undefined, { count, type: pageType ?? 'all', scope: withinLastHour ? '1h' : 'all' });

  const noun = count === 1 ? 'page' : 'pages';
  const scope = withinLastHour ? ' from the last hour' : '';
  return c.redirect(`/admin/trash?flash=${encodeURIComponent(`Restored ${count} ${noun}${scope} to drafts`)}`);
});

// ── Permanently delete from trash ─────────────────────────────────────────────

trashRoutes.post('/trash/:id/delete', requirePermission('trash:purge'), async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();
  logAudit(c, 'page.purge', 'page', trashId);
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});

// ── Empty trash (all, by type, or last-hour only) ────────────────────────────
// Accepts optional form fields:
//   type   — page type to purge (empty = all types)
//   action — "now" (default) purge all matching; "1h" purge only those trashed within the last hour

trashRoutes.post('/trash/empty', requirePermission('trash:purge'), async (c) => {
  const form = await c.req.formData();
  const pageType = (form.get('type') as string | null)?.trim() || null;
  const withinLastHour = (form.get('action') as string | null)?.trim() === '1h';

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (pageType) {
    conditions.push('page_type = ?');
    params.push(pageType);
  }
  if (withinLastHour) conditions.push(`created_at >= datetime('now', '-1 hour')`);

  await c.env.DB.prepare(
    `DELETE FROM trash_pages${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`,
  ).bind(...params).run();
  logAudit(c, 'page.purge_all', 'page', undefined);

  const label = pageType ? `${pageType}+pages` : 'Trash';
  const flash = withinLastHour ? `${label}+from+last+hour+emptied` : `${label}+emptied`;
  return c.redirect(`/admin/trash?flash=${flash}`);
});
