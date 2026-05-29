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
//   POST /admin/pages/:id/delete        – delete from draft
//   GET  /admin/tags                    – tag list (stub, extensible)
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, editorGuard } from '../middleware/auth';
import { dashboardPage } from '../templates/dashboard';
import { editorPage } from '../templates/editor';
import type { Env, Variables, Page, PageVersion, Tag } from '../types';

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

  const draftPages = await c.env.DRAFT_DB.prepare(
    'SELECT * FROM pages ORDER BY weight ASC, name ASC',
  ).all<Page>();

  const liveSlugs = new Set<string>();
  if (draftPages.results.length > 0) {
    const livePages = await c.env.LIVE_DB.prepare(
      'SELECT uuid FROM pages',
    ).all<{ uuid: string }>();
    livePages.results.forEach((p) => liveSlugs.add(p.uuid));
  }

  const pages = draftPages.results.map((p) => ({
    ...p,
    isPublished: liveSlugs.has(p.uuid),
  }));

  // Fetch user avatar from DB
  const dbUser = await c.env.LIVE_DB.prepare(
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
    c.env.DRAFT_DB.prepare('SELECT id, name, slug FROM pages ORDER BY name ASC').all<Page>(),
    c.env.LIVE_DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.LIVE_DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
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
      c.env.DRAFT_DB.prepare('SELECT id, name, slug FROM pages ORDER BY name ASC').all<Page>(),
      c.env.LIVE_DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
      c.env.LIVE_DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
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
  const pageResult = await c.env.DRAFT_DB.prepare(
    `INSERT INTO pages (name, slug, weight, start, end, page_type, original, page_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, slug, weightVal, startVal, endVal, pageTypeVal, originalVal, pageIdVal ? parseInt(pageIdVal, 10) : null)
    .run();

  const pageId = pageResult.meta.last_row_id as number;

  // Insert page version
  const versionResult = await c.env.DRAFT_DB.prepare(
    `INSERT INTO page_versions (page_id, content, meta) VALUES (?, ?, ?)`,
  )
    .bind(pageId, content || null, meta)
    .run();

  const versionId = versionResult.meta.last_row_id as number;

  // Link current version
  await c.env.DRAFT_DB.prepare(
    'UPDATE pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(versionId, pageId)
    .run();

  // Save tag associations
  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DRAFT_DB.prepare(
      'INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)',
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
    c.env.DRAFT_DB.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first<Page>(),
    c.env.DRAFT_DB.prepare('SELECT id, name, slug FROM pages ORDER BY name ASC').all<Page>(),
    c.env.LIVE_DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.LIVE_DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  if (!page) return c.notFound();

  const [version, pageTags] = await Promise.all([
    page.current_page_version_id
      ? c.env.DRAFT_DB.prepare('SELECT * FROM page_versions WHERE id = ?')
          .bind(page.current_page_version_id)
          .first<PageVersion>()
      : Promise.resolve(null),
    c.env.DRAFT_DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?')
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

  const page = await c.env.DRAFT_DB.prepare('SELECT * FROM pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  if (errors.length) {
    const [parentPages, tags, version, pageTags, dbUser] = await Promise.all([
      c.env.DRAFT_DB.prepare('SELECT id, name, slug FROM pages ORDER BY name ASC').all<Page>(),
      c.env.LIVE_DB.prepare('SELECT id, name, slug FROM tags ORDER BY name ASC').all<Tag>(),
      page.current_page_version_id
        ? c.env.DRAFT_DB.prepare('SELECT * FROM page_versions WHERE id = ?')
            .bind(page.current_page_version_id)
            .first<PageVersion>()
        : Promise.resolve(null),
      c.env.DRAFT_DB.prepare('SELECT tag_id FROM page_tags WHERE page_id = ?').bind(pageId).all<{ tag_id: number }>(),
      c.env.LIVE_DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
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
  await c.env.DRAFT_DB.prepare(
    `UPDATE pages SET name=?, slug=?, weight=?, start=?, end=?, page_type=?, original=?, page_id=? WHERE id=?`,
  )
    .bind(name, slug, weightVal, startVal, endVal, pageTypeVal, originalVal, pageIdVal ? parseInt(pageIdVal, 10) : null, pageId)
    .run();

  // Create new page version
  const versionResult = await c.env.DRAFT_DB.prepare(
    `INSERT INTO page_versions (page_id, content, meta) VALUES (?, ?, ?)`,
  )
    .bind(pageId, content || null, meta)
    .run();

  const newVersionId = versionResult.meta.last_row_id as number;

  await c.env.DRAFT_DB.prepare(
    'UPDATE pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(newVersionId, pageId)
    .run();

  // Replace tag associations
  await c.env.DRAFT_DB.prepare('DELETE FROM page_tags WHERE page_id = ?')
    .bind(pageId)
    .run();

  const tagIds = form.getAll('tag_ids');
  for (const tagId of tagIds) {
    await c.env.DRAFT_DB.prepare(
      'INSERT OR IGNORE INTO page_tags (page_id, tag_id) VALUES (?, ?)',
    )
      .bind(pageId, parseInt(String(tagId), 10))
      .run();
  }

  return c.redirect('/admin?flash=Page+updated+successfully');
});

// ── Publish (DRAFT → LIVE) ────────────────────────────────────────────────────

adminRoutes.post('/pages/:id/publish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DRAFT_DB.prepare('SELECT * FROM pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  const version = page.current_page_version_id
    ? await c.env.DRAFT_DB.prepare('SELECT * FROM page_versions WHERE id = ?')
        .bind(page.current_page_version_id)
        .first<PageVersion>()
    : null;

  // Upsert page into LIVE DB (match on uuid)
  await c.env.LIVE_DB.prepare(
    `INSERT INTO pages (uuid, name, slug, weight, start, end, page_type, original, page_id)
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

  // Fetch the LIVE page id (may differ from draft)
  const livePageRow = await c.env.LIVE_DB.prepare(
    'SELECT id, current_page_version_id FROM pages WHERE uuid = ?',
  )
    .bind(page.uuid)
    .first<{ id: number; current_page_version_id: number | null }>();

  if (livePageRow && version) {
    // Upsert the current page version into LIVE DB
    await c.env.LIVE_DB.prepare(
      `INSERT INTO page_versions (uuid, page_id, content, meta)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(uuid) DO UPDATE SET
         content = excluded.content,
         meta = excluded.meta`,
    )
      .bind(version.uuid, livePageRow.id, version.content, version.meta)
      .run();

    const liveVersion = await c.env.LIVE_DB.prepare(
      'SELECT id FROM page_versions WHERE uuid = ?',
    )
      .bind(version.uuid)
      .first<{ id: number }>();

    if (liveVersion) {
      await c.env.LIVE_DB.prepare(
        'UPDATE pages SET current_page_version_id = ? WHERE id = ?',
      )
        .bind(liveVersion.id, livePageRow.id)
        .run();
    }
  }

  return c.redirect('/admin?flash=Page+published+successfully');
});

// ── Unpublish (remove from LIVE) ──────────────────────────────────────────────

adminRoutes.post('/pages/:id/unpublish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DRAFT_DB.prepare('SELECT uuid FROM pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string }>();
  if (!page) return c.notFound();

  await c.env.LIVE_DB.prepare('DELETE FROM pages WHERE uuid = ?')
    .bind(page.uuid)
    .run();

  return c.redirect('/admin?flash=Page+unpublished');
});

// ── Delete page (from DRAFT only) ─────────────────────────────────────────────

adminRoutes.post('/pages/:id/delete', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  await c.env.DRAFT_DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId).run();
  return c.redirect('/admin?flash=Page+deleted');
});

// ── Tags list (stub) ──────────────────────────────────────────────────────────

adminRoutes.get('/tags', async (c) => {
  const user = c.get('user');
  const [tags, dbUser] = await Promise.all([
    c.env.LIVE_DB.prepare('SELECT * FROM tags ORDER BY name ASC').all<Tag>(),
    c.env.LIVE_DB.prepare('SELECT avatar_url FROM users WHERE id = ?')
      .bind(parseInt(user.sub, 10))
      .first<{ avatar_url: string | null }>(),
  ]);

  const rows = tags.results
    .map(
      (t) =>
        `<tr class="hover:bg-gray-50">
           <td class="px-6 py-3 text-sm font-medium text-gray-900">${t.name}</td>
           <td class="px-6 py-3 text-sm font-mono text-gray-500">${t.slug}</td>
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

  const { layout } = await import('../templates/layout');
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
