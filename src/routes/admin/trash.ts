// Trash listing, restore-to-draft, and permanent delete.

import { Hono } from 'hono';
import { trashPage } from '../../templates/trash';
import type { Env, Variables, Page, PageTag } from '../../types';
import { userIdFromContext } from '../../utils/forms';
import { fetchUserAvatar, savePageVersion } from '../../utils/admin-queries';
import { buildBaseProps } from '../../utils/admin-render';
import { logAudit } from '../../utils/audit';

export const trashRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// ── Trash list ────────────────────────────────────────────────────────────────

trashRoutes.get('/trash', async (c) => {
  const flash = c.req.query('flash') ?? '';

  const [trashedPages, userAvatar] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM trash_pages ORDER BY updated_at DESC').all<Page>(),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);

  return c.html(await trashPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    pages: trashedPages.results,
    flash: flash || undefined,
  }));
});

// ── Restore page from trash → draft ──────────────────────────────────────────

trashRoutes.post('/trash/:id/restore', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);

  const trashedPage = await c.env.DB.prepare('SELECT * FROM trash_pages WHERE id = ?')
    .bind(trashId)
    .first<Page>();
  if (!trashedPage) return c.notFound();

  // Upsert page back into draft page table (match on uuid)
  await c.env.DB.prepare(
    `INSERT INTO draft_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
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
      trashedPage.uuid,
      trashedPage.name,
      trashedPage.slug,
      trashedPage.weight,
      trashedPage.start,
      trashedPage.end,
      trashedPage.page_type,
      trashedPage.lect,
      trashedPage.page_id,
      trashedPage.creator,
      trashedPage.editors,
    )
    .run();

  const draftPage = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE uuid = ?')
    .bind(trashedPage.uuid)
    .first<{ id: number }>();

  if (draftPage) {
    const restoredVersionId = await savePageVersion(
      c.env.DB,
      draftPage.id,
      trashedPage.lect,
      'restore',
    );

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

    await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
      .bind(restoredVersionId, draftPage.id)
      .run();
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

trashRoutes.post('/trash/:id/delete', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();
  logAudit(c, 'page.purge', 'page', trashId);
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});
