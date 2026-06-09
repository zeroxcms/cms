// Page dashboard, listing, create/edit/update, weight, publish/unpublish, and soft-delete.

import { Hono } from 'hono';
import { dashboardPage } from '../../templates/dashboard';
import { editorPage } from '../../templates/editor';
import { resolveCmsConfig } from '../../plugins/config';
import { dispatchHook } from '../../plugins/hooks';
import { viewsFor } from '../../plugins/views';
import { blueprintToLect, stringifyLect } from '../../utils/lect';
import type { Env, Variables, Page, PageVersion, PageTag } from '../../types';
import {
  dashboardPageHref,
  dashboardPageNumber,
  dashboardPageSize,
  editorsFromForm,
  languageFromRequest,
  nullableStr,
  num,
  safeAdminReturnPath,
  slugify,
  str,
  userIdFromContext,
} from '../../utils/forms';
import { validatePageBasics } from '../../utils/validation';
import {
  applyStructuredAction,
  blockPropsByName,
  blueprintPropsFor,
  isStructuredEditorAction,
  lectForPage,
  lectFromForm,
  lectsMatch,
  withDraftMetadata,
} from '../../utils/page-logic';
import {
  editorTaxonomy,
  fetchUserAvatar,
  listDashboardDraftPages,
  liveMapForDraftPages,
  parentPageOption,
  publishPage,
  savePageVersion,
  unpublishPage,
} from '../../utils/admin-queries';
import { buildBaseProps, dashboardPagination, exportPageList } from '../../utils/admin-render';

export const pagesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Tell the page's sync Durable Object that the page was saved, so it commits
// the live overlay and notifies connected editors. Best-effort.
async function notifyPageSaved(env: Env, pageId: number): Promise<void> {
  try {
    const id = env.PAGE_SYNC.idFromName(`page-${pageId}`);
    await env.PAGE_SYNC.get(id).fetch('https://page-sync/?action=saved', { method: 'POST' });
  } catch {
    // Sync is a non-critical overlay; never block a save on it.
  }
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

pagesRoutes.get('/', async (c) => {
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));

  if (search) {
    return c.redirect(`/admin/advanced-search?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await listDashboardDraftPages(c.env.DB, {
    page: requestedPage,
    limit: pageSize,
  });
  const liveMap = await liveMapForDraftPages(c.env.PUBLISHED_DB, draftPages.results);

  const pages = draftPages.results.map((p) => ({
    ...p,
    isPublished: liveMap.has(p.uuid),
    liveWeight: liveMap.get(p.uuid)?.weight,
    hasLiveWeightDrift: liveMap.has(p.uuid) && liveMap.get(p.uuid)?.weight !== p.weight,
    hasLiveLectDrift: liveMap.has(p.uuid) && !lectsMatch(liveMap.get(p.uuid)?.lect, p.lect),
  }));

  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));

  return c.html(
    await dashboardPage(c.env.VIEWS, {
      ...(await buildBaseProps(c, userAvatar)),
      pages,
      flash: flash || undefined,
      returnPath: dashboardPageHref('/admin', draftPages.pagination.currentPage, pageSize),
      searchAction: '/admin/advanced-search',
      advancedSearchHref: '/admin/advanced-search',
      importHref: '/admin/pages/import-v2/default',
      exportHref: '/admin/pages/export',
      pagination: dashboardPagination('/admin', draftPages),
    }),
  );
});

pagesRoutes.get('/pages/list/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));

  if (search) {
    return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await listDashboardDraftPages(c.env.DB, {
    pageType,
    page: requestedPage,
    limit: pageSize,
  });
  const liveMap = await liveMapForDraftPages(c.env.PUBLISHED_DB, draftPages.results);
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  const routeBase = `/admin/pages/list/${encodeURIComponent(pageType)}`;

  return c.html(
    await dashboardPage(c.env.VIEWS, {
      ...(await buildBaseProps(c, userAvatar)),
      siteTitle: `${c.env.SITE_TITLE ?? 'Worker CMS'} · ${pageType}`,
      pages: draftPages.results.map((page) => ({
        ...page,
        isPublished: liveMap.has(page.uuid),
        liveWeight: liveMap.get(page.uuid)?.weight,
        hasLiveWeightDrift: liveMap.has(page.uuid) && liveMap.get(page.uuid)?.weight !== page.weight,
        hasLiveLectDrift: liveMap.has(page.uuid) && !lectsMatch(liveMap.get(page.uuid)?.lect, page.lect),
      })),
      flash: flash || undefined,
      returnPath: dashboardPageHref(routeBase, draftPages.pagination.currentPage, pageSize),
      pageTypeFilter: pageType,
      searchAction: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
      advancedSearchHref: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
      importHref: `/admin/pages/import-v2/${encodeURIComponent(pageType)}`,
      exportHref: `/admin/pages/export/${encodeURIComponent(pageType)}`,
      pagination: dashboardPagination(routeBase, draftPages),
    }),
  );
});

pagesRoutes.get('/pages/export', (c) => exportPageList(c));

pagesRoutes.get('/pages/export/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return exportPageList(c, pageType);
});

pagesRoutes.get('/pages/search/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const search = c.req.query('search') ?? '';
  return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
});

pagesRoutes.get('/pages/create_by_type/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  return c.redirect(`/admin/pages/new?page_type=${encodeURIComponent(pageType)}`);
});

pagesRoutes.post('/pages/new_post/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const creator = userIdFromContext(c);
  const name = str(form.get('name')) || `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const slug = str(form.get('slug')) || slugify(name);
  const config = await resolveCmsConfig(c.env);
  const lect = stringifyLect(
    withDraftMetadata(
      lectFromForm(
        config,
        pageType,
        blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
        form,
        language,
      ),
      userIdFromContext(c),
    ),
  );

  const result = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, slug, num(form.get('weight')), pageType, lect, creator || null, editorsFromForm(form))
    .run();
  const page = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  if (!page) return c.notFound();

  const versionId = await savePageVersion(c.env.DB, page.id, lect, 'create');
  await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
    .bind(versionId, page.id)
    .run();

  dispatchHook(c, 'create', { id: page.id, page_type: pageType, name, slug });

  return c.redirect(`/admin/pages/${page.id}/edit`);
});

// ── New page form ─────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/new', async (c) => {
  const pageType = c.req.query('page_type') || 'default';
  const language = languageFromRequest(c);
  const config = await resolveCmsConfig(c.env);
  const lect = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const [taxonomy, userAvatar] = await Promise.all([
    editorTaxonomy(c.env.DB),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);

  return c.html(
    await editorPage(viewsFor(c.env), {
      ...(await buildBaseProps(c, userAvatar)),
      parentPages: [],
      tags: taxonomy.tags,
      tagTypes: taxonomy.tagTypes,
      selectedTagIds: [],
      action: '/admin/pages',
      defaultPageType: pageType,
      structured: {
        config,
        language,
        lect,
        blueprintProps: blueprintPropsFor(config, pageType),
        blockProps: blockPropsByName(config),
        blockNames: config.blockLists[pageType] ?? config.blockLists.default,
        versions: [],
      },
    }),
  );
});

// ── Create page ───────────────────────────────────────────────────────────────

pagesRoutes.post('/pages', async (c) => {
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);
  const config = await resolveCmsConfig(c.env);

  if (errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const [parentPages, taxonomy, userAvatar] = await Promise.all([
      parentPageOption(c.env.DB, nullableStr(form.get('page_id'))),
      editorTaxonomy(c.env.DB),
      fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    ]);
    return c.html(
      await editorPage(viewsFor(c.env), {
        ...(await buildBaseProps(c, userAvatar)),
        parentPages,
        tags: taxonomy.tags,
        tagTypes: taxonomy.tagTypes,
        selectedTagIds: [],
        errors,
        action: '/admin/pages',
        defaultPageType: pageType,
        structured: {
          config,
          language,
          lect: lectFromForm(
            config,
            pageType,
            blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
            form,
            language,
          ),
          blueprintProps: blueprintPropsFor(config, pageType),
          blockProps: blockPropsByName(config),
          blockNames: config.blockLists[pageType] ?? config.blockLists.default,
          versions: [],
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const creator = userIdFromContext(c);
  const editorsVal = editorsFromForm(form);
  const lectVal = stringifyLect(
    withDraftMetadata(
      lectFromForm(
        config,
        pageTypeVal,
        blueprintToLect(pageTypeVal, config.blueprint, config.defaultLanguage),
        form,
        language,
      ),
      userIdFromContext(c),
    ),
  );

  // Insert page
  const pageResult = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      name,
      slug,
      weightVal,
      startVal,
      endVal,
      pageTypeVal,
      lectVal,
      pageIdVal ? parseInt(pageIdVal, 10) : null,
      creator || null,
      editorsVal,
    )
    .run();

  // The schema uses a custom DEFAULT id expression (not INTEGER PRIMARY KEY),
  // so last_row_id is the internal rowid — we must SELECT the actual id back.
  const pageRow = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
    .bind(pageResult.meta.last_row_id)
    .first<{ id: number }>();
  const pageId = pageRow!.id;

  // Insert page version
  const versionId = await savePageVersion(c.env.DB, pageId, lectVal, 'create');

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

  dispatchHook(c, 'create', { id: pageId, page_type: pageTypeVal, name, slug });

  return c.redirect('/admin?flash=Page+created+successfully');
});

// ── Edit page form ────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/:id/edit', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const language = languageFromRequest(c);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const flash = c.req.query('flash') ?? '';

  const [page, taxonomy, userAvatar] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>(),
    editorTaxonomy(c.env.DB),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);

  if (!page) return c.notFound();

  const [version, versions, livePage, pageTags] = await Promise.all([
    Number.isFinite(requestedVersionId)
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
          .bind(pageId, requestedVersionId)
          .first<PageVersion>()
      : page.current_page_version_id
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE id = ?')
          .bind(page.current_page_version_id)
          .first<PageVersion>()
      : Promise.resolve(null),
    c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
      .bind(pageId)
      .all<PageVersion>(),
    c.env.PUBLISHED_DB.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
      .bind(page.uuid)
      .first<{ lect: string | null }>(),
    c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<{ tag_id: number }>(),
  ]);
  const pageType = page.page_type ?? 'default';
  const config = await resolveCmsConfig(c.env);
  const lect = lectForPage(config, pageType, version?.lect ?? page.lect);
  const displayPage = { ...page, lect: stringifyLect(lect) };
  const parentPages = await parentPageOption(c.env.DB, page.page_id);

  return c.html(
    await editorPage(viewsFor(c.env), {
      ...(await buildBaseProps(c, userAvatar)),
      page: displayPage,
      version: version ?? undefined,
      isVersionPreview: Number.isFinite(requestedVersionId) && !!version,
      liveVersionId: versions.results.find((candidate) => candidate.lect === livePage?.lect)?.id,
      parentPages,
      tags: taxonomy.tags,
      tagTypes: taxonomy.tagTypes,
      selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
      flash: flash || undefined,
      action: `/admin/pages/${pageId}`,
      structured: {
        config,
        language,
        lect,
        blueprintProps: blueprintPropsFor(config, pageType),
        blockProps: blockPropsByName(config),
        blockNames: config.blockLists[pageType] ?? config.blockLists.default,
        versions: versions.results,
      },
    }),
  );
});

pagesRoutes.post('/pages/:id/weight', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const weight = num(form.get('weight'));
  const returnPath = safeAdminReturnPath(form.get('return_to'));

  const result = await c.env.DB.prepare('UPDATE draft_pages SET weight = ? WHERE id = ?')
    .bind(weight, pageId)
    .run();
  if (!result.success) {
    return c.redirect(`${returnPath}${returnPath.includes('?') ? '&' : '?'}flash=Weight+update+failed`);
  }

  return c.redirect(`${returnPath}${returnPath.includes('?') ? '&' : '?'}flash=Draft+weight+updated`);
});

// ── Update page ───────────────────────────────────────────────────────────────

pagesRoutes.post('/pages/:id', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const action = str(form.get('action'));

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  const config = await resolveCmsConfig(c.env);

  if (action.startsWith('revert:')) {
    const versionId = parseInt(action.split(':')[1], 10);
    const version = await c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
      .bind(pageId, versionId)
      .first<PageVersion>();
    if (!version) return c.notFound();
    await c.env.DB.prepare('UPDATE draft_pages SET lect = ?, current_page_version_id = ? WHERE id = ?')
      .bind(version.lect ?? page.lect, version.id, pageId)
      .run();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+restored`);
  }

  if (errors.length) {
    const [parentPages, taxonomy, version, versions, livePage, pageTags, userAvatar] = await Promise.all([
      parentPageOption(c.env.DB, nullableStr(form.get('page_id')) ?? page.page_id),
      editorTaxonomy(c.env.DB),
      page.current_page_version_id
        ? c.env.DB.prepare('SELECT * FROM page_versions WHERE id = ?')
            .bind(page.current_page_version_id)
            .first<PageVersion>()
        : Promise.resolve(null),
      c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
        .bind(pageId)
        .all<PageVersion>(),
      c.env.PUBLISHED_DB.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
        .bind(page.uuid)
        .first<{ lect: string | null }>(),
      c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?').bind(pageId).all<{ tag_id: number }>(),
      fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    ]);
    const pageType = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
    const lect = lectFromForm(config, pageType, lectForPage(config, pageType, page.lect), form, language);
    return c.html(
      await editorPage(viewsFor(c.env), {
        ...(await buildBaseProps(c, userAvatar)),
        page,
        version: version ?? undefined,
        liveVersionId: versions.results.find((candidate) => candidate.lect === livePage?.lect)?.id,
        parentPages,
        tags: taxonomy.tags,
        tagTypes: taxonomy.tagTypes,
        selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
        errors,
        action: `/admin/pages/${pageId}`,
        structured: {
          config,
          language,
          lect,
          blueprintProps: blueprintPropsFor(config, pageType),
          blockProps: blockPropsByName(config),
          blockNames: config.blockLists[pageType] ?? config.blockLists.default,
          versions: versions.results,
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const pageIdVal = nullableStr(form.get('page_id'));
  const weightVal = num(form.get('weight'));
  const editorsVal = editorsFromForm(form);
  const lect = applyStructuredAction(
    config,
    lectFromForm(config, pageTypeVal, lectForPage(config, pageTypeVal, page.lect), form, language),
    pageTypeVal,
    action,
    form,
  );
  const lectVal = stringifyLect(withDraftMetadata(lect, userIdFromContext(c)));

  // Update page metadata
  await c.env.DB.prepare(
    `UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, page_type=?, lect=?, page_id=?, editors=? WHERE id=?`,
  )
    .bind(
      name,
      slug,
      weightVal,
      startVal,
      endVal,
      pageTypeVal,
      lectVal,
      pageIdVal ? parseInt(pageIdVal, 10) : null,
      editorsVal,
      pageId,
    )
    .run();

  const newVersionId = await savePageVersion(
    c.env.DB,
    pageId,
    lectVal,
    action || 'update',
  );

  await c.env.DB.prepare(
    'UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?',
  )
    .bind(newVersionId, pageId)
    .run();

  // Commit the live CRDT overlay: clears uncommitted ops so a save-then-leave
  // doesn't revert, and pushes the saved values as everyone's new baseline.
  await notifyPageSaved(c.env, pageId);

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

  if (action === 'publish') {
    await publishPage(c.env.DB, c.env.PUBLISHED_DB, pageId);
    dispatchHook(c, 'publish', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug });
    return c.redirect('/admin?flash=Page+published+successfully');
  }

  if (isStructuredEditorAction(action)) {
    return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}`);
  }

  dispatchHook(c, 'update', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug });

  return c.redirect('/admin?flash=Page+updated+successfully');
});

// ── Publish (DRAFT → PUBLISHED) ───────────────────────────────────────────────

pagesRoutes.post('/pages/:id/publish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const published = await publishPage(c.env.DB, c.env.PUBLISHED_DB, pageId);
  if (!published) return c.notFound();

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  dispatchHook(c, 'publish', {
    id: pageId,
    uuid: page?.uuid,
    name: page?.name,
    slug: page?.slug,
    page_type: page?.page_type,
  });

  return c.redirect('/admin?flash=Page+published+successfully');
});

// ── Unpublish (remove from published DB) ──────────────────────────────────────

pagesRoutes.post('/pages/:id/unpublish', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!page) return c.notFound();

  await unpublishPage(c.env.PUBLISHED_DB, page.uuid);

  dispatchHook(c, 'unpublish', {
    id: pageId,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect('/admin?flash=Page+unpublished');
});

// ── Delete page → move to TRASH (soft-delete) ────────────────────────────────

pagesRoutes.post('/pages/:id/delete', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  // Copy page into trash table (preserve uuid so we can restore)
  await c.env.DB.prepare(
    `INSERT INTO trash_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
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

  // Fetch the trash page id
  const trashPage = await c.env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?')
    .bind(page.uuid)
    .first<{ id: number }>();

  if (trashPage) {
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

  // Unpublish from the published DB before deleting the draft copy.
  await unpublishPage(c.env.PUBLISHED_DB, page.uuid);

  // Delete from DRAFT
  await c.env.DB.prepare('DELETE FROM draft_pages WHERE id = ?').bind(pageId).run();

  dispatchHook(c, 'delete', {
    id: page.id,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect('/admin?flash=Page+moved+to+trash');
});
