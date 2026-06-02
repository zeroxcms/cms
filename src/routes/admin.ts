// ============================================================
// Admin routes (all protected by authMiddleware + editorGuard)
//
//   GET  /admin                         – dashboard (draft pages)
//   GET  /admin/pages/new               – new page form
//   POST /admin/pages                   – create page
//   GET  /admin/pages/:id/edit          – edit page form
//   POST /admin/pages/:id               – update page
//   POST /admin/pages/:id/publish       – publish draft → live
//   POST /admin/pages/:id/unpublish     – unpublish from live
//   POST /admin/pages/:id/delete        – soft-delete to trash (unpublishes too)
//   GET  /admin/trash                   – list trashed pages
//   POST /admin/trash/:id/restore       – restore page from trash → draft
//   POST /admin/trash/:id/delete        – permanently delete from trash
//   GET  /admin/tags                    – tag list (stub, extensible)
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, editorGuard } from '../middleware/auth';
import { dashboardPage } from '../templates/dashboard';
import { editorPage } from '../templates/editor';
import type { Env, Variables, Page, PageVersion, PageTag, Tag } from '../types';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

// ── Helper: parse form data safely ────────────────────────────────────────────

// FormDataEntryValue is File | string in the Fetch API
type FormValue = File | string | null | undefined;

function str(v: FormValue): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nullableStr(v: FormValue): string | null {
  const s = str(v);
  return s === '' ? null : s;
}

function num(v: FormValue, fallback = 5): number {
  const n = parseInt(str(v), 10);
  return isNaN(n) ? fallback : n;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

adminRoutes.get('/', async (c) => {
  const user = c.get('user');
  const flash = c.req.query('flash') ?? '';

  const draftPages = await c.env.DB.prepare(
    'SELECT * FROM draft_pages ORDER BY weight ASC, name ASC',
  ).all<Page>();

  const liveSlugs = new Set<string>();
  if (draftPages.results.length > 0) {
    const livePages = await c.env.DB.prepare(
      'SELECT uuid FROM live_pages',
    ).all<{ uuid: string }>();
    livePages.results.forEach((p) => liveSlugs.add(p.uuid));
  }

  const pages = draftPages.results.map((p) => ({
    ...p,
    isPublished: liveSlugs.has(p.uuid),
  }));

  // Fetch user avatar from DB
  const dbUser = await c.env.DB.prepare(
    'SELECT avatar_url FROM users WHERE id = ?',
  )
    .bind(parseInt(user.sub, 10))
    .first<{ avatar_url: string | null }>();

  return c.html(
    dashboardPage({
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      pages,
      flash: flash || undefined,
    }),
  );
});

// ── New page form ─────────────────────────────────────────────────────────────

adminRoutes.get('/pages/new', async (c) => {
  const user = c.get('user');
  const [parentPages, tags, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
    c.env.DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  return c.html(
    editorPage({
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      parentPages: parentPages.results,
      tags: tags.results,
      selectedTagIds: [],
      action: '/admin/pages',
    }),
  );
});

// ── Create page ───────────────────────────────────────────────────────────────

adminRoutes.post('/pages', async (c) => {
  const user = c.get('user');
  const form = await c.req.formData();

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors: string[] = [];
  if (!name) errors.push('Page name is required.');
  if (!slug) errors.push('Slug is required.');
  if (!/^[a-z0-9-]+$/.test(slug)) errors.push('Slug may only contain lowercase letters, numbers and hyphens.');

  if (errors.length) {
    const [parentPages, tags, dbUser] = await Promise.all([
      c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
      c.env.DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
      c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
        .bind(parseInt(user.sub, 10))
        .first<{ avatar_url: string | null }>(),
    ]);
    return c.html(
      editorPage({
        siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
        userName: user.name,
        userRole: user.role,
        userAvatar: dbUser?.avatar_url ?? '',
        parentPages: parentPages.results,
        tags: tags.results,
        selectedTagIds: [],
        errors,
        action: '/admin/pages',
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type'));
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const originalVal = nullableStr(form.get('original'));
  const weightVal = num(form.get('weight'));
  const content = str(form.get('content'));
  const meta = nullableStr(form.get('meta'));

  // Insert page
  const pageResult = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, start, end, page_type, original, page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, slug, weightVal, startVal, endVal, pageTypeVal, originalVal, pageIdVal ? parseInt(pageIdVal, 10) : null)
    .run();

  // The schema uses a custom DEFAULT id expression (not INTEGER PRIMARY KEY),
  // so last_row_id is the internal rowid — we must SELECT the actual id back.
  const pageRow = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
    .bind(pageResult.meta.last_row_id)
    .first<{ id: number }>();
  const pageId = pageRow!.id;

  // Insert page version
  const versionResult = await c.env.DB.prepare(
    `INSERT INTO draft_page_versions (page_id, content, meta) VALUES (?, ?, ?)`,
  )
    .bind(pageId, content || null, meta)
    .run();

  const versionRow = await c.env.DB.prepare('SELECT id FROM draft_page_versions WHERE rowid = ?')
    .bind(versionResult.meta.last_row_id)
    .first<{ id: number }>();
  const versionId = versionRow!.id;

  // Link current version
  await c.env.DB.prepare(
    'UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(versionId, pageId)
    .run();

  // Save tag associations
  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)',
    )
      .bind(pageId, parseInt(String(tagId), 10))
      .run();
  }

  return c.redirect('/admin?flash=Page+created+successfully');
});

// ── Edit page form ────────────────────────────────────────────────────────────

adminRoutes.get('/pages/:id/edit', async (c) => {
  const user = c.get('user');
  const pageId = parseInt(c.req.param('id'), 10);

  const [page, parentPages, tags, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>(),
    c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
    c.env.DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  if (!page) return c.notFound();

  const [version, pageTags] = await Promise.all([
    page.current_page_version_id
      ? c.env.DB.prepare('SELECT * FROM draft_page_versions WHERE id = ?')
          .bind(page.current_page_version_id)
          .first<PageVersion>()
      : Promise.resolve(null),
    c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<{ tag_id: number }>(),
  ]);

  return c.html(
    editorPage({
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
      page,
      version: version ?? undefined,
      parentPages: parentPages.results,
      tags: tags.results,
      selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
      action: `/admin/pages/${pageId}`,
    }),
  );
});

// ── Update page ───────────────────────────────────────────────────────────────

adminRoutes.post('/pages/:id', async (c) => {
  const user = c.get('user');
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors: string[] = [];
  if (!name) errors.push('Page name is required.');
  if (!slug) errors.push('Slug is required.');
  if (slug && !/^[a-z0-9-]+$/.test(slug)) errors.push('Slug may only contain lowercase letters, numbers and hyphens.');

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  if (errors.length) {
    const [parentPages, tags, version, pageTags, dbUser] = await Promise.all([
      c.env.DB.prepare('SELECT id, name, slug FROM draft_pages ORDER BY name ASC').all<Page>(),
      c.env.DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
      page.current_page_version_id
        ? c.env.DB.prepare('SELECT * FROM draft_page_versions WHERE id = ?')
            .bind(page.current_page_version_id)
            .first<PageVersion>()
        : Promise.resolve(null),
      c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?').bind(pageId).all<{ tag_id: number }>(),
      c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
        .bind(parseInt(user.sub, 10))
        .first<{ avatar_url: string | null }>(),
    ]);
    return c.html(
      editorPage({
        siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
        userName: user.name,
        userRole: user.role,
        userAvatar: dbUser?.avatar_url ?? '',
        page,
        version: version ?? undefined,
        parentPages: parentPages.results,
        tags: tags.results,
        selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
        errors,
        action: `/admin/pages/${pageId}`,
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type'));
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const originalVal = nullableStr(form.get('original'));
  const weightVal = num(form.get('weight'));
  const content = str(form.get('content'));
  const meta = nullableStr(form.get('meta'));

  // Update page metadata
  await c.env.DB.prepare(
    `UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, page_type=?, original=?, page_id=? WHERE id=?`,
  )
    .bind(name, slug, weightVal, startVal, endVal, pageTypeVal, originalVal, pageIdVal ? parseInt(pageIdVal, 10) : null, pageId)
    .run();

  // Create new page version
  const versionResult = await c.env.DB.prepare(
    `INSERT INTO draft_page_versions (page_id, content, meta) VALUES (?, ?, ?)`,
  )
    .bind(pageId, content || null, meta)
    .run();

  const newVersionRow = await c.env.DB.prepare('SELECT id FROM draft_page_versions WHERE rowid = ?')
    .bind(versionResult.meta.last_row_id)
    .first<{ id: number }>();
  const newVersionId = newVersionRow!.id;

  await c.env.DB.prepare(
    'UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(newVersionId, pageId)
    .run();

  // Replace tag associations
  await c.env.DB.prepare('DELETE FROM draft_page_tags WHERE page_id = ?')
    .bind(pageId)
    .run();

  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)',
    )
      .bind(pageId, parseInt(String(tagId), 10))
      .run();
  }

  return c.redirect('/admin?flash=Page+updated+successfully');
});

// ── Publish (DRAFT → LIVE) ────────────────────────────────────────────────────

adminRoutes.post('/pages/:id/publish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  // Upsert page into live content table (match on uuid)
  await c.env.DB.prepare(
    `INSERT INTO live_pages (uuid, name, slug, weight, start, end, page_type, original, page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       original = excluded.original,
       page_id = excluded.page_id`,
  )
    .bind(page.uuid, page.name, page.slug, page.weight, page.start, page.end, page.page_type, page.original, page.page_id)
    .run();

  return c.redirect('/admin?flash=Page+published+successfully');
});

// ── Unpublish (remove from LIVE) ──────────────────────────────────────────────

adminRoutes.post('/pages/:id/unpublish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT uuid FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string }>();
  if (!page) return c.notFound();

  await c.env.DB.prepare('DELETE FROM live_pages WHERE uuid = ?')
    .bind(page.uuid)
    .run();

  return c.redirect('/admin?flash=Page+unpublished');
});

// ── Delete page → move to TRASH (soft-delete) ────────────────────────────────

adminRoutes.post('/pages/:id/delete', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  // Copy page into trash table (preserve uuid so we can restore)
  await c.env.DB.prepare(
    `INSERT INTO trash_pages (uuid, name, slug, weight, start, end, page_type, current_page_version_id, original, page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       original = excluded.original,
       page_id = excluded.page_id`,
  )
    .bind(page.uuid, page.name, page.slug, page.weight, page.start, page.end, page.page_type, page.current_page_version_id, page.original, page.page_id)
    .run();

  // Fetch the trash page id
  const trashPage = await c.env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();

  if (trashPage) {
    // Copy page versions into trash
    const versions = await c.env.DB.prepare('SELECT * FROM draft_page_versions WHERE page_id = ?')
      .bind(pageId)
      .all<PageVersion>();
    for (const v of versions.results) {
      await c.env.DB.prepare(
        `INSERT INTO trash_page_versions (uuid, page_id, content, meta)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET content = excluded.content, meta = excluded.meta`,
      )
        .bind(v.uuid, trashPage.id, v.content, v.meta)
        .run();
    }

    // Copy page tags into trash
    const pageTags = await c.env.DB.prepare('SELECT * FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<PageTag>();
    for (const pt of pageTags.results) {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO trash_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)`,
      )
        .bind(pt.uuid, trashPage.id, pt.tag_id, pt.weight)
        .run();
    }
  }

  // Unpublish from live (remove by uuid)
  await c.env.DB.prepare('DELETE FROM live_pages WHERE uuid = ?').bind(page.uuid).run();

  // Delete from DRAFT
  await c.env.DB.prepare('DELETE FROM draft_pages WHERE id = ?').bind(pageId).run();

  return c.redirect('/admin?flash=Page+moved+to+trash');
});

// ── Trash list ────────────────────────────────────────────────────────────────

adminRoutes.get('/trash', async (c) => {
  const user = c.get('user');
  const flash = c.req.query('flash') ?? '';

  const [trashedPages, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM trash_pages ORDER BY updated_at DESC').all<Page>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  const { layout } = await import('../templates/layout');
  const { escHtml } = await import('../templates/layout');

  const flashBanner = flash
    ? `<div id="flash" class="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">${escHtml(flash)}</div>`
    : '';

  const tableRows = trashedPages.results.length
    ? trashedPages.results
        .map(
          (p) => `
        <tr class="hover:bg-gray-50 transition-colors">
          <td class="px-6 py-4">
            <div class="font-medium text-gray-900">${escHtml(p.name)}</div>
            <div class="text-sm text-gray-500 font-mono">/${escHtml(p.slug)}</div>
          </td>
          <td class="px-6 py-4 text-sm text-gray-500">${escHtml(p.page_type ?? '—')}</td>
          <td class="px-6 py-4 text-sm text-gray-400">${escHtml(p.updated_at)}</td>
          <td class="px-6 py-4">
            <div class="flex items-center gap-2">
              <form method="POST" action="/admin/trash/${p.id}/restore" class="inline">
                <button type="submit"
                        class="text-indigo-600 hover:text-indigo-800 text-sm font-medium">Restore</button>
              </form>
              <form method="POST" action="/admin/trash/${p.id}/delete" class="inline"
                    onsubmit="return confirm('Permanently delete this page? This cannot be undone.')">
                <button type="submit"
                        class="text-red-500 hover:text-red-700 text-sm font-medium">Delete Forever</button>
              </form>
            </div>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr>
        <td colspan="4" class="px-6 py-12 text-center text-gray-400">Trash is empty.</td>
       </tr>`;

  const body = `
    <div class="px-8 py-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-2xl font-bold text-gray-900">Trash</h2>
          <p class="text-sm text-gray-500 mt-1">${trashedPages.results.length} page${trashedPages.results.length !== 1 ? 's' : ''} in trash</p>
        </div>
        <a href="/admin" class="text-sm text-indigo-600 hover:underline">← Back to Pages</a>
      </div>

      ${flashBanner}

      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Page</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Deleted</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>

    <script>
      const flash = document.getElementById('flash');
      if (flash) setTimeout(() => flash.remove(), 4000);
    </script>`;

  return c.html(
    layout({
      title: 'Trash',
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      body,
      admin: true,
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
    }),
  );
});

// ── Restore page from trash → draft ──────────────────────────────────────────

adminRoutes.post('/trash/:id/restore', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);

  const trashPage = await c.env.DB.prepare('SELECT * FROM trash_pages WHERE id = ?')
    .bind(trashId)
    .first<Page>();
  if (!trashPage) return c.notFound();

  // Upsert page back into draft content table (match on uuid)
  await c.env.DB.prepare(
    `INSERT INTO draft_pages (uuid, name, slug, weight, start, end, page_type, original, page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uuid) DO UPDATE SET
       name = excluded.name,
       slug = excluded.slug,
       weight = excluded.weight,
       start = excluded.start,
       end = excluded.end,
       page_type = excluded.page_type,
       original = excluded.original,
       page_id = excluded.page_id`,
  )
    .bind(trashPage.uuid, trashPage.name, trashPage.slug, trashPage.weight, trashPage.start, trashPage.end, trashPage.page_type, trashPage.original, trashPage.page_id)
    .run();

  const draftPage = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE uuid = ?')
    .bind(trashPage.uuid)
    .first<{ id: number }>();

  if (draftPage) {
    // Restore page versions to draft
    const trashVersions = await c.env.DB.prepare('SELECT * FROM trash_page_versions WHERE page_id = ?')
      .bind(trashId)
      .all<PageVersion>();
    let lastVersionId: number | null = null;
    for (const v of trashVersions.results) {
      await c.env.DB.prepare(
        `INSERT INTO draft_page_versions (uuid, page_id, content, meta)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET content = excluded.content, meta = excluded.meta`,
      )
        .bind(v.uuid, draftPage.id, v.content, v.meta)
        .run();

      const restoredVersion = await c.env.DB.prepare('SELECT id FROM draft_page_versions WHERE uuid = ?')
        .bind(v.uuid)
        .first<{ id: number }>();
      lastVersionId = restoredVersion?.id ?? lastVersionId;
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

    // Restore current_page_version_id pointer if we have versions
    if (lastVersionId !== null) {
      await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
        .bind(lastVersionId, draftPage.id)
        .run();
    }
  }

  // Remove from TRASH
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();

  return c.redirect('/admin/trash?flash=Page+restored+to+draft');
});

// ── Permanently delete from trash ─────────────────────────────────────────────

adminRoutes.post('/trash/:id/delete', async (c) => {
  const trashId = parseInt(c.req.param('id'), 10);
  await c.env.DB.prepare('DELETE FROM trash_pages WHERE id = ?').bind(trashId).run();
  return c.redirect('/admin/trash?flash=Page+permanently+deleted');
});

// ── Tags list (stub) ──────────────────────────────────────────────────────────

adminRoutes.get('/tags', async (c) => {
  const user = c.get('user');
  const [tags, dbUser] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  const { layout, escHtml } = await import('../templates/layout');

  const rows = tags.results
    .map(
      (t) =>
        `<tr class="hover:bg-gray-50">
           <td class="px-6 py-3 text-sm font-medium text-gray-900">${escHtml(t.name)}</td>
           <td class="px-6 py-3 text-sm font-mono text-gray-500">${escHtml(t.slug)}</td>
         </tr>`,
    )
    .join('');

  const body = `
    <div class="px-8 py-8">
      <h2 class="text-2xl font-bold text-gray-900 mb-6">Tags</h2>
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Slug</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${rows || '<tr><td colspan="2" class="px-6 py-10 text-center text-gray-400">No tags yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  return c.html(
    layout({
      title: 'Tags',
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      body,
      admin: true,
      userName: user.name,
      userRole: user.role,
      userAvatar: dbUser?.avatar_url ?? '',
    }),
  );
});
