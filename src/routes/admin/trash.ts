// Trash listing, restore-to-draft, and permanent delete.

import { Hono } from 'hono';
import { trashPage } from '../../templates/trash';
import type { Env, Variables, Page, PageTag, PageVersion } from '../../types';
import { savePageVersion } from '../../utils/admin-queries';
import { dashboardPagination, renderPage } from '../../utils/admin-render';
import { dashboardPageNumber, dashboardPageSize } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';

export const trashRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Trash list ────────────────────────────────────────────────────────────────

trashRoutes.get('/trash', async (c) => {
  const flash = c.req.query('flash') ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));

  const countRow = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM trash_pages').first<{ total: number }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const trashedPages = await c.env.DB.prepare(
    'SELECT * FROM trash_pages ORDER BY updated_at DESC LIMIT ? OFFSET ?',
  ).bind(pageSize, offset).all<Page>();

  const paginationResult = {
    results: trashedPages.results,
    pagination: { total, totalPages, currentPage, limit: pageSize },
  };

  return renderPage(c, trashPage, {
    pages: trashedPages.results,
    flash: flash || undefined,
    pagination: dashboardPagination('/admin/trash', paginationResult),
    total,
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

// ── Permanently delete from trash ─────────────────────────────────────────────

trashRoutes.post('/trash/:id/delete', requirePermission('trash:purge'), async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();
  logAudit(c, 'page.purge', 'page', trashId);
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});

// ── Empty entire trash ────────────────────────────────────────────────────────

trashRoutes.post('/trash/empty', requirePermission('trash:purge'), async (c) => {
  await c.env.DB.prepare('DELETE FROM trash_pages').run();
  logAudit(c, 'page.purge_all', 'page', undefined);
  return c.redirect('/admin/trash?flash=Trash+emptied');
});
