// Page dashboard, listing, create/edit/update, weight, publish/unpublish, and soft-delete.

import { Hono } from 'hono';
import { dashboardPage } from '../../templates/dashboard';
import { editorPage } from '../../templates/editor';
import { resolveCmsConfig } from '../../plugins/config';
import { dispatchHook } from '../../plugins/hooks';
import { viewsFor } from '../../plugins/views';
import { pluginEditView } from '../../plugins/edit-view';
import { blueprintToLect, safeParseLect, stringifyLect } from '../../utils/lect';
import type { Env, Variables, Page, PageVersion } from '../../types';
import type { BlueprintEntry } from '../../cms-config';
import {
  dashboardPageHref,
  dashboardPageNumber,
  dashboardPageSize,
  dashboardStatusFilter,
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
  blockNamesFor,
  blockPropsByName,
  blueprintPropsFor,
  isStructuredEditorAction,
  lectForPage,
  lectFromForm,
  withDraftMetadata,
  withLiveStatus,
} from '../../utils/page-logic';
import {
  editorTaxonomy,
  ensureUniqueDraftSlug,
  fetchUserName,
  listAllDashboardDraftPages,
  listDashboardDraftPages,
  listDashboardDraftPagesByUuids,
  parentPageOption,
  trashDraftPage,
} from '../../utils/admin-queries';
import {
  describeFailures,
  getLiveLect,
  liveMapForDraftPages,
  publishPageToTargets,
  unpublishPageFromTargets,
} from '../../publish';
import type { PublishOutcome } from '../../publish';
import { buildBaseProps, dashboardPagination, exportPageList, renderPage } from '../../utils/admin-render';
import { requirePermission } from '../../middleware/auth';
import type { AppContext } from '../../utils/context';
import { notifyPageSaved, savePageVersionAndSetCurrent, setDraftPageTags } from '../../utils/page-store';

export const pagesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type DashboardStatusFilter = ReturnType<typeof dashboardStatusFilter>;
type DashboardLiveRow = { uuid: string; lect: string | null; weight: number };

function statusFilterLinks(routeBase: string, active: DashboardStatusFilter) {
  return [
    { label: 'All', href: routeBase, isActive: active === '' },
    { label: 'Draft', href: `${routeBase}?status=draft`, isActive: active === 'draft' },
    { label: 'Live', href: `${routeBase}?status=live`, isActive: active === 'live' },
  ];
}

function paginateDashboardPages<T extends Page>(pages: T[], requestedPage: number, limit: number) {
  const total = pages.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * limit;
  return {
    results: pages.slice(offset, offset + limit),
    pagination: {
      total,
      totalPages,
      currentPage,
      limit,
    },
  };
}

async function liveDashboardPagesForRequest(
  c: AppContext,
  options: { pageType?: string; requestedPage: number; pageSize: number },
) {
  const { pageType, requestedPage, pageSize } = options;
  const whereSql = pageType ? 'WHERE page_type = ?' : '';
  const baseParams = pageType ? [pageType] : [];
  const countRow = await c.env.PUBLISHED_DB.prepare(`SELECT COUNT(*) AS total FROM live_pages ${whereSql}`)
    .bind(...baseParams)
    .first<{ total: number }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(requestedPage, totalPages);
  const currentOffset = (currentPage - 1) * pageSize;
  const liveRows = await c.env.PUBLISHED_DB.prepare(
    `SELECT uuid, lect, weight FROM live_pages ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, pageSize, currentOffset)
    .all<DashboardLiveRow>();
  const liveMap = new Map(liveRows.results.map((page) => [page.uuid, page]));
  const draftRows = await listDashboardDraftPagesByUuids(
    c.env.DB,
    liveRows.results.map((page) => page.uuid),
    { pageType },
  );
  const draftMap = new Map(draftRows.map((page) => [page.uuid, page]));
  const results = liveRows.results
    .map((page) => draftMap.get(page.uuid))
    .filter((page): page is Page => !!page);

  return {
    results: withLiveStatus(results, liveMap),
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: pageSize,
    },
  };
}

async function dashboardPagesForRequest(
  c: AppContext,
  options: { pageType?: string; statusFilter: DashboardStatusFilter; requestedPage: number; pageSize: number },
) {
  const { pageType, statusFilter, requestedPage, pageSize } = options;
  if (!statusFilter) {
    const draftPages = await listDashboardDraftPages(c.env.DB, {
      pageType,
      page: requestedPage,
      limit: pageSize,
    });
    const liveMap = await liveMapForDraftPages(c.env, draftPages.results);
    return {
      ...draftPages,
      results: withLiveStatus(draftPages.results, liveMap),
    };
  }
  if (statusFilter === 'live') {
    return liveDashboardPagesForRequest(c, { pageType, requestedPage, pageSize });
  }

  const allDraftPages = await listAllDashboardDraftPages(c.env.DB, { pageType });
  const liveMap = await liveMapForDraftPages(c.env, allDraftPages);
  const pages = withLiveStatus(allDraftPages, liveMap)
    .filter((page) => !page.isPublished);
  return paginateDashboardPages(pages, requestedPage, pageSize);
}

// Escape hatch: `?native=1` (or `?editor=cms`) forces the built-in CMS editor
// even for a page type a plugin would otherwise render (see plugins/edit-view.ts).
// The flag is threaded through the editor's form action and save redirects so it
// survives validation re-renders and the post-save reload.
function preferNativeEditor(c: AppContext): boolean {
  const native = (c.req.query('native') ?? '').toLowerCase();
  const editor = (c.req.query('editor') ?? '').toLowerCase();
  return native === '1' || native === 'true' || editor === 'cms' || editor === 'native';
}

/** Appends the native-editor flag to a URL when it's active (keeps `?`/`&` correct). */
function withNativeFlag(c: AppContext, url: string): string {
  if (!preferNativeEditor(c)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}native=1`;
}

function pageTypeHasPrivacyFields(entries: BlueprintEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) => {
    if (typeof entry === 'string') {
      const name = entry.replace(/^[*@]/, '').split(':')[0].toLowerCase();
      return name.includes('email') || name.includes('phone') || name === 'mobile' || name === 'fax';
    }
    return Object.values(entry).some(pageTypeHasPrivacyFields);
  });
}

// Flash message for a publish fan-out: plain success, or success qualified
// with the targets that failed (failures are already logged by the registry).
function publishFlash(outcome: PublishOutcome): string {
  const failed = describeFailures(outcome);
  if (!failed) return 'Page+published+successfully';
  return encodeURIComponent(`Page published, but these targets failed: ${failed}`);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

pagesRoutes.get('/', async (c) => {
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));
  const statusFilter = dashboardStatusFilter(c.req.query('status'));

  if (search) {
    return c.redirect(`/admin/advanced-search?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await dashboardPagesForRequest(c, {
    statusFilter,
    requestedPage,
    pageSize,
  });
  const routeBase = '/admin';
  const statusParams = statusFilter ? { status: statusFilter } : {};

  return renderPage(c, dashboardPage, {
    pages: draftPages.results,
    flash: flash || undefined,
    returnPath: dashboardPageHref(routeBase, draftPages.pagination.currentPage, pageSize, statusParams),
    statusFilter,
    statusFilters: statusFilterLinks(routeBase, statusFilter),
    searchAction: '/admin/advanced-search',
    advancedSearchHref: '/admin/advanced-search',
    importHref: '/admin/pages/import-v2/default',
    exportHref: '/admin/pages/export',
    pagination: dashboardPagination(routeBase, draftPages, statusParams),
  });
});

pagesRoutes.get('/pages/list/:pageType', async (c) => {
  const pageType = c.req.param('pageType');
  const flash = c.req.query('flash') ?? '';
  const search = c.req.query('search')?.trim() ?? '';
  const pageSize = dashboardPageSize(c.req.query('pagesize'));
  const requestedPage = dashboardPageNumber(c.req.query('page'));
  const statusFilter = dashboardStatusFilter(c.req.query('status'));

  if (search) {
    return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
  }

  const draftPages = await dashboardPagesForRequest(c, {
    pageType,
    statusFilter,
    requestedPage,
    pageSize,
  });
  const routeBase = `/admin/pages/list/${encodeURIComponent(pageType)}`;
  const statusParams = statusFilter ? { status: statusFilter } : {};
  const config = await resolveCmsConfig(c.env);

  return renderPage(c, dashboardPage, {
      siteTitle: `${c.env.SITE_TITLE ?? '0xCMS'} · ${pageType}`,
      pages: draftPages.results,
      flash: flash || undefined,
      returnPath: dashboardPageHref(routeBase, draftPages.pagination.currentPage, pageSize, statusParams),
      pageTypeFilter: pageType,
      statusFilter,
      statusFilters: statusFilterLinks(routeBase, statusFilter),
      searchAction: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
      advancedSearchHref: `/admin/advanced-search/${encodeURIComponent(pageType)}`,
      importHref: `/admin/pages/import-v2/${encodeURIComponent(pageType)}`,
      exportHref: `/admin/pages/export/${encodeURIComponent(pageType)}`,
      pagination: dashboardPagination(routeBase, draftPages, statusParams),
      privacyTable: pageTypeHasPrivacyFields(config.blueprint[pageType]),
  });
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

pagesRoutes.post('/pages/new_post/:pageType', requirePermission('content:write'), async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const creator = userIdFromContext(c);
  const name = str(form.get('name')) || `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const slug = await ensureUniqueDraftSlug(c.env.DB, str(form.get('slug')) || slugify(name));
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

  await savePageVersionAndSetCurrent(c.env.DB, page.id, lect, 'create');

  dispatchHook(c, 'create', { id: page.id, page_type: pageType, name, slug });

  return c.redirect(`/admin/pages/${page.id}/edit`);
});

// ── New page form ─────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/new', async (c) => {
  const pageType = c.req.query('page_type') || 'default';
  const language = languageFromRequest(c);
  const config = await resolveCmsConfig(c.env);
  const lect = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const taxonomy = await editorTaxonomy(c.env.DB);

  if (!preferNativeEditor(c)) {
    const pluginView = await pluginEditView(c, pageType, {
      mode: 'new',
      action: '/admin/pages',
      backHref: safeAdminReturnPath(c.req.query('return_to')),
      language,
      pageType,
      page: {
        id: '',
        name: '',
        slug: '',
        pageType,
        weight: 5,
        start: null,
        end: null,
        timezone: c.env.DEFAULT_TIMEZONE ?? '+0800',
        editors: null,
        lect: stringifyLect(lect),
      },
      versions: [],
    });
    if (pluginView) return pluginView;
  }

  return renderPage(c, editorPage, {
    parentPages: [],
    tags: taxonomy.tags,
    taxonomies: taxonomy.taxonomies,
    selectedTagIds: [],
    action: withNativeFlag(c, '/admin/pages'),
    defaultPageType: pageType,
    defaultTimezone: c.env.DEFAULT_TIMEZONE ?? '+0800',
    backHref: safeAdminReturnPath(c.req.query('return_to')),
    structured: {
      config,
      language,
      lect,
      blueprintProps: blueprintPropsFor(config, pageType),
      blockProps: blockPropsByName(config),
      blockNames: blockNamesFor(config, pageType),
      versions: [],
    },
  }, viewsFor(c.env));
});

// ── Create page ───────────────────────────────────────────────────────────────

pagesRoutes.post('/pages', requirePermission('content:write'), async (c) => {
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);
  const config = await resolveCmsConfig(c.env);
  const backHref = safeAdminReturnPath(form.get('return_to'));

  if (errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const lect = lectFromForm(
      config,
      pageType,
      blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
      form,
      language,
    );

    if (!preferNativeEditor(c)) {
      const pluginView = await pluginEditView(c, pageType, {
        mode: 'new',
        action: '/admin/pages',
        backHref,
        language,
        pageType,
        page: {
          id: '',
          name,
          slug,
          pageType,
          weight: num(form.get('weight')),
          start: nullableStr(form.get('start')),
          end: nullableStr(form.get('end')),
          timezone: nullableStr(form.get('timezone')) ?? c.env.DEFAULT_TIMEZONE ?? '+0800',
          editors: editorsFromForm(form),
          lect: stringifyLect(lect),
        },
        versions: [],
        errors,
      });
      if (pluginView) return pluginView;
    }

    const [parentPages, taxonomy] = await Promise.all([
      parentPageOption(c.env.DB, nullableStr(form.get('page_id'))),
      editorTaxonomy(c.env.DB),
    ]);
    return c.html(
      await editorPage(viewsFor(c.env), {
        ...(await buildBaseProps(c)),
        parentPages,
        tags: taxonomy.tags,
        taxonomies: taxonomy.taxonomies,
        selectedTagIds: [],
        errors,
        action: withNativeFlag(c, '/admin/pages'),
        defaultPageType: pageType,
        defaultTimezone: c.env.DEFAULT_TIMEZONE ?? '+0800',
        backHref,
        structured: {
          config,
          language,
          lect,
          blueprintProps: blueprintPropsFor(config, pageType),
          blockProps: blockPropsByName(config),
          blockNames: blockNamesFor(config, pageType),
          versions: [],
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const timezoneVal = nullableStr(form.get('timezone')) ?? c.env.DEFAULT_TIMEZONE ?? '+0800';
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
  const uniqueSlug = await ensureUniqueDraftSlug(c.env.DB, slug);
  const pageResult = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, start, end, timezone, page_type, lect, page_id, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      name,
      uniqueSlug,
      weightVal,
      startVal,
      endVal,
      timezoneVal,
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
  await savePageVersionAndSetCurrent(c.env.DB, pageId, lectVal, 'create');
  await setDraftPageTags(c.env.DB, pageId, form.getAll('tag_ids'), false);

  dispatchHook(c, 'create', { id: pageId, page_type: pageTypeVal, name, slug: uniqueSlug });

  const createdFlash = 'flash=Page+created+successfully';
  return c.redirect(`${backHref}${backHref.includes('?') ? '&' : '?'}${createdFlash}`);
});

pagesRoutes.post('/pages/batch-weight', requirePermission('content:write'), async (c) => {
  const body = await c.req.json<{ updates: { id: number; weight: number }[] }>();
  const { updates } = body;

  if (!Array.isArray(updates)) return c.json({ error: 'Invalid input' }, 400);

  const statements = [];
  for (const update of updates) {
    const id = Number(update?.id);
    const weight = Number(update?.weight);
    if (!Number.isInteger(id) || id <= 0 || !Number.isFinite(weight)) {
      return c.json({ error: 'Invalid input' }, 400);
    }
    statements.push(c.env.DB.prepare('UPDATE draft_pages SET weight = ? WHERE id = ?').bind(weight, id));
  }

  if (!statements.length) return c.json({ success: true });

  const results = await c.env.DB.batch(statements);
  if (results.some((r) => !r.success)) {
    return c.json({ error: 'Some updates failed' }, 500);
  }

  return c.json({ success: true });
});

// ── Edit page form ────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/:id/edit', async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const language = languageFromRequest(c);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const flash = c.req.query('flash') ?? '';
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const [page, taxonomy] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>(),
    editorTaxonomy(c.env.DB),
  ]);

  if (!page) return c.notFound();

  const [version, versions, liveLect, pageTags] = await Promise.all([
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
    getLiveLect(c.env, page.uuid),
    c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
      .bind(pageId)
      .all<{ tag_id: number }>(),
  ]);
  const pageType = page.page_type ?? 'default';
  const config = await resolveCmsConfig(c.env);
  const lect = lectForPage(config, pageType, version?.lect ?? page.lect);
  const displayPage = { ...page, lect: stringifyLect(lect) };
  const [parentPages, modifierName] = await Promise.all([
    parentPageOption(c.env.DB, page.page_id),
    fetchUserName(c.env.DB, num(lect._modifier, 0)),
  ]);

  if (!preferNativeEditor(c)) {
    const pluginView = await pluginEditView(c, pageType, {
      mode: 'edit',
      action: `/admin/pages/${pageId}`,
      backHref,
      language,
      pageType,
      page: {
        id: page.id,
        name: page.name,
        slug: page.slug,
        pageType,
        weight: page.weight,
        start: page.start,
        end: page.end,
        timezone: page.timezone,
        editors: page.editors,
        lect: stringifyLect(lect),
      },
      versions: versions.results.map((v) => ({ id: v.id, created_at: v.created_at, action: v.action })),
      flash: flash || undefined,
    });
    if (pluginView) return pluginView;
  }

  return renderPage(c, editorPage, {
    page: displayPage,
    modifierName: modifierName ?? undefined,
    version: version ?? undefined,
    isVersionPreview: Number.isFinite(requestedVersionId) && !!version,
    liveVersionId: versions.results.find((candidate) => candidate.lect === liveLect)?.id,
    parentPages,
    tags: taxonomy.tags,
    taxonomies: taxonomy.taxonomies,
    selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
    flash: flash || undefined,
    action: withNativeFlag(c, `/admin/pages/${pageId}`),
    backHref,
    defaultTimezone: c.env.DEFAULT_TIMEZONE ?? '+0800',
    // Current draft lect, so a version preview can diff against it.
    draftLect: stringifyLect(lectForPage(config, pageType, page.lect)),
    structured: {
      config,
      language,
      lect,
      blueprintProps: blueprintPropsFor(config, pageType),
      blockProps: blockPropsByName(config),
      blockNames: blockNamesFor(config, pageType),
      versions: versions.results,
    },
  }, viewsFor(c.env));
});

pagesRoutes.post('/pages/:id/weight', requirePermission('content:write'), async (c) => {
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

pagesRoutes.post('/pages/:id', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const language = languageFromRequest(c, form);
  const action = str(form.get('action'));
  const backHref = safeAdminReturnPath(form.get('return_to'));

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
    const revertedLect = stringifyLect(
      withDraftMetadata(safeParseLect(version.lect ?? page.lect), userIdFromContext(c)),
    );
    await c.env.DB.prepare('UPDATE draft_pages SET lect = ?, current_page_version_id = ? WHERE id = ?')
      .bind(revertedLect, version.id, pageId)
      .run();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+restored`);
  }

  if (errors.length) {
    const [parentPages, taxonomy, version, versions, liveLect, pageTags] = await Promise.all([
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
      getLiveLect(c.env, page.uuid),
      c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?').bind(pageId).all<{ tag_id: number }>(),
    ]);
    const pageType = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
    const lect = lectFromForm(config, pageType, lectForPage(config, pageType, page.lect), form, language);

    if (!preferNativeEditor(c)) {
      const pluginView = await pluginEditView(c, pageType, {
        mode: 'edit',
        action: `/admin/pages/${pageId}`,
        backHref,
        language,
        pageType,
        page: {
          id: pageId,
          name,
          slug,
          pageType,
          weight: num(form.get('weight')),
          start: nullableStr(form.get('start')),
          end: nullableStr(form.get('end')),
          timezone: nullableStr(form.get('timezone')) ?? page.timezone,
          editors: editorsFromForm(form),
          lect: stringifyLect(lect),
        },
        versions: versions.results.map((v) => ({ id: v.id, created_at: v.created_at, action: v.action })),
        errors,
      });
      if (pluginView) return pluginView;
    }

    return c.html(
      await editorPage(viewsFor(c.env), {
        ...(await buildBaseProps(c)),
        page,
        version: version ?? undefined,
        liveVersionId: versions.results.find((candidate) => candidate.lect === liveLect)?.id,
        parentPages,
        tags: taxonomy.tags,
        taxonomies: taxonomy.taxonomies,
        selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
        errors,
        action: withNativeFlag(c, `/admin/pages/${pageId}`),
        backHref,
        defaultTimezone: c.env.DEFAULT_TIMEZONE ?? '+0800',
        structured: {
          config,
          language,
          lect,
          blueprintProps: blueprintPropsFor(config, pageType),
          blockProps: blockPropsByName(config),
          blockNames: blockNamesFor(config, pageType),
          versions: versions.results,
        },
      }),
      422,
    );
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const timezoneVal = nullableStr(form.get('timezone'));
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
  const uniqueSlug = await ensureUniqueDraftSlug(c.env.DB, slug, pageId);
  await c.env.DB.prepare(
    `UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, timezone=?, page_type=?, lect=?, page_id=?, editors=? WHERE id=?`,
  )
    .bind(
      name,
      uniqueSlug,
      weightVal,
      startVal,
      endVal,
      timezoneVal,
      pageTypeVal,
      lectVal,
      pageIdVal ? parseInt(pageIdVal, 10) : null,
      editorsVal,
      pageId,
    )
    .run();

  await savePageVersionAndSetCurrent(
    c.env.DB,
    pageId,
    lectVal,
    action || 'update',
  );

  // Commit the live CRDT overlay: clears uncommitted ops so a save-then-leave
  // doesn't revert, and pushes the saved values as everyone's new baseline.
  await notifyPageSaved(c.env, pageId);

  await setDraftPageTags(c.env.DB, pageId, form.getAll('tag_ids'), true);

  if (action === 'publish') {
    const outcome = await publishPageToTargets(c.env, pageId);
    if (!outcome) return c.notFound();
    dispatchHook(c, 'publish', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });
    return c.redirect(`/admin?flash=${publishFlash(outcome)}`);
  }

  // Preserve where the editor returns to (e.g. a plugin dashboard) across saves,
  // so the back arrow / Cancel button still point there after a save reload.
  const returnToParam = backHref !== '/admin' ? `&return_to=${encodeURIComponent(backHref)}` : '';
  // Keep the built-in-editor override across the post-save reload.
  const nativeParam = preferNativeEditor(c) ? '&native=1' : '';

  if (isStructuredEditorAction(action)) {
    return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}${returnToParam}${nativeParam}`);
  }

  dispatchHook(c, 'update', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });

  return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}&flash=Page+updated+successfully${returnToParam}${nativeParam}`);
});

// ── Publish (DRAFT → PUBLISHED) ───────────────────────────────────────────────

pagesRoutes.post('/pages/:id/publish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const outcome = await publishPageToTargets(c.env, pageId);
  if (!outcome) return c.notFound();

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

  return c.redirect(`/admin?flash=${publishFlash(outcome)}`);
});

// ── Unpublish (remove from published DB) ──────────────────────────────────────

pagesRoutes.post('/pages/:id/unpublish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!page) return c.notFound();

  await unpublishPageFromTargets(c.env, page.uuid);

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

pagesRoutes.post('/pages/:id/delete', requirePermission('content:delete'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);

  // Copy the page (and its version + tag history) into trash, preserving ids so
  // a later restore keeps the same identity. Shared with the plugin write-back
  // API so the trash schema lives in one place.
  const page = await trashDraftPage(c.env.DB, pageId);
  if (!page) return c.notFound();

  // Unpublish from every publish target now that the draft copy is gone.
  await unpublishPageFromTargets(c.env, page.uuid);

  dispatchHook(c, 'delete', {
    id: page.id,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect('/admin?flash=Page+moved+to+trash');
});
