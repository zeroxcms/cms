// Page dashboard, listing, create/edit/update, weight, publish/unpublish, and soft-delete.

import { Hono } from 'hono';
import { dashboardPage } from '../../templates/dashboard';
import { editorPage } from '../../templates/editor';
import { readPage } from '../../templates/read';
import { resolveCmsConfig } from '../../plugins/config';
import { dispatchHook } from '../../plugins/hooks';
import { viewsFor } from '../../plugins/views';
import { pluginEditView, pluginNewView, pluginReadView } from '../../plugins/edit-view';
import { pluginAutoPublishesPageType } from '../../plugins/registry';
import type { EditViewContext, ReadViewContext } from '../../plugins/edit-view';
import { blueprintToLect, safeParseLect, stringifyLect } from '../../utils/lect';
import type { Lect } from '../../utils/lect';
import type { Env, Variables, Page, PageVersion } from '../../types';
import type { BlueprintEntry } from '../../cms-config';
import {
  appendQuery,
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
import { checkCreateLimits, createCandidate, limitViolationMessage } from '../../utils/plugin-limits';
import { pageCreateAction, pageCreateCostForType, refundCredits, spendCredits, type CreditSource } from '../../utils/credits';
import {
  applyStructuredAction,
  blockNamesFor,
  blockPropsByName,
  blueprintPropsFor,
  isStructuredEditorAction,
  lectForPage,
  lectFromForm,
  lectsMatch,
  withDraftMetadata,
  withLiveStatus,
} from '../../utils/page-logic';
import {
  editorTaxonomy,
  ensureUniqueDraftSlug,
  fetchUserName,
  listDashboardDraftPages,
  listDashboardDraftPageUuids,
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
import { draftLectProjector } from '../../publish/projection';
import { dashboardPagination, importExportHrefs, renderPage, userCan } from '../../utils/admin-render';
import { loadAdminHomeSettings } from '../../utils/settings';
import { requirePermission } from '../../middleware/auth';
import type { AppContext } from '../../utils/context';
import {
  notifyPageSaved,
  pullPublishedPageToDraft,
  savePageVersionAndSetCurrent,
  setDraftPageTags,
} from '../../utils/page-store';
import { isSubmissionMirror } from '../../utils/submission-ingest';

export const pagesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

type DashboardStatusFilter = ReturnType<typeof dashboardStatusFilter>;
type DashboardLiveUuidRow = { uuid: string };
type DashboardPageRow = Page & { isDraftMissing?: boolean };

function statusFilterLinks(routeBase: string, active: DashboardStatusFilter) {
  return [
    { label: 'All', href: routeBase, isActive: active === '' },
    { label: 'Draft', href: `${routeBase}?status=draft`, isActive: active === 'draft' },
    { label: 'Live', href: `${routeBase}?status=live`, isActive: active === 'live' },
  ];
}

function dashboardPaginationResult<T>(items: T[], requestedPage: number, limit: number) {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(requestedPage, totalPages);
  const offset = (currentPage - 1) * limit;
  return {
    results: items.slice(offset, offset + limit),
    pagination: {
      total,
      totalPages,
      currentPage,
      limit,
    },
  };
}

async function liveDashboardUuids(c: AppContext): Promise<Set<string>> {
  const liveRows = await c.env.PUBLISHED_DB.prepare('SELECT uuid FROM live_pages')
    .all<DashboardLiveUuidRow>();
  return new Set(liveRows.results.map((page) => page.uuid));
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
    `SELECT * FROM live_pages ${whereSql}
     ORDER BY weight ASC, name ASC, id ASC
     LIMIT ? OFFSET ?`,
  )
    .bind(...baseParams, pageSize, currentOffset)
    .all<Page>();
  const liveMap = new Map(liveRows.results.map((page) => [page.uuid, page]));
  const draftRows = await listDashboardDraftPagesByUuids(
    c.env.DB,
    liveRows.results.map((page) => page.uuid),
    { pageType },
  );
  const draftMap = new Map(draftRows.map((page) => [page.uuid, page]));
  const results: DashboardPageRow[] = liveRows.results.map((page) => {
    const draft = draftMap.get(page.uuid);
    return draft ?? { ...page, current_page_version_id: null, isDraftMissing: true };
  });
  const projectDraft = await draftLectProjector(c.env);

  return {
    results: withLiveStatus(results, liveMap, projectDraft),
    pagination: {
      total,
      totalPages,
      currentPage,
      limit: pageSize,
    },
  };
}

async function draftDashboardPagesForRequest(
  c: AppContext,
  options: { pageType?: string; requestedPage: number; pageSize: number },
) {
  const { pageType, requestedPage, pageSize } = options;
  const [draftUuids, liveUuids] = await Promise.all([
    listDashboardDraftPageUuids(c.env.DB, { pageType }),
    liveDashboardUuids(c),
  ]);
  const draftOnlyUuids = draftUuids.filter((uuid) => !liveUuids.has(uuid));
  const paginated = dashboardPaginationResult(draftOnlyUuids, requestedPage, pageSize);
  const draftRows = await listDashboardDraftPagesByUuids(c.env.DB, paginated.results);
  const draftMap = new Map(draftRows.map((page) => [page.uuid, page]));
  const results = paginated.results
    .map((uuid) => draftMap.get(uuid))
    .filter((page): page is Page => !!page);

  return {
    results: withLiveStatus(results, new Map()),
    pagination: paginated.pagination,
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
    const [liveMap, projectDraft] = await Promise.all([
      liveMapForDraftPages(c.env, draftPages.results),
      draftLectProjector(c.env),
    ]);
    return {
      ...draftPages,
      results: withLiveStatus(draftPages.results, liveMap, projectDraft),
    };
  }
  if (statusFilter === 'live') {
    return liveDashboardPagesForRequest(c, { pageType, requestedPage, pageSize });
  }

  return draftDashboardPagesForRequest(c, { pageType, requestedPage, pageSize });
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
  if (outcome.refused) return encodeURIComponent('Submission pages cannot be published — they mirror source data from the published database');
  const failed = describeFailures(outcome);
  if (!failed) return 'Page+published+successfully';
  return encodeURIComponent(`Page published, but these targets failed: ${failed}`);
}

// ── Shared editor rendering ───────────────────────────────────────────────────

type ResolvedConfig = Awaited<ReturnType<typeof resolveCmsConfig>>;

function defaultTimezone(c: AppContext): string {
  return c.env.DEFAULT_TIMEZONE ?? '+0800';
}

/** The `structured` prop block shared by every built-in editor render. */
function structuredEditorProps(
  config: ResolvedConfig,
  language: string,
  lect: Lect,
  pageType: string,
  versions: PageVersion[] = [],
) {
  return {
    config,
    language,
    lect,
    blueprintProps: blueprintPropsFor(config, pageType),
    blockProps: blockPropsByName(config),
    blockNames: blockNamesFor(config, pageType),
    versions,
  };
}

/** EditViewContext.page built from a submitted editor form (validation re-renders). */
function pluginPageFromForm(
  form: FormData,
  base: { id: number | string; name: string; slug: string; pageType: string },
  lect: Lect,
  fallbackTimezone: string | null,
): EditViewContext['page'] {
  return {
    ...base,
    weight: num(form.get('weight')),
    start: nullableStr(form.get('start')),
    end: nullableStr(form.get('end')),
    timezone: nullableStr(form.get('timezone')) ?? fallbackTimezone,
    editors: editorsFromForm(form),
    lect: stringifyLect(lect),
  };
}

/**
 * Renders through the owning plugin's edit view, unless the native-editor
 * escape hatch is active. Returns null when the caller should render the
 * built-in editor instead.
 */
async function maybePluginEditView(
  c: AppContext,
  context: Omit<EditViewContext, 'versions'> & { versions?: PageVersion[] },
): Promise<Response | null> {
  if (preferNativeEditor(c)) return null;
  return pluginEditView(c, context.pageType, {
    ...context,
    versions: (context.versions ?? []).map((v) => ({ id: v.id, created_at: v.created_at, action: v.action })),
  });
}

/**
 * Renders the new/create form through the owning plugin, unless the native
 * editor escape hatch is active. Returns null when the caller should render the
 * built-in editor instead.
 */
async function maybePluginNewView(
  c: AppContext,
  context: Omit<EditViewContext, 'versions'> & { versions?: PageVersion[] },
): Promise<Response | null> {
  if (preferNativeEditor(c)) return null;
  return pluginNewView(c, context.pageType, {
    ...context,
    versions: (context.versions ?? []).map((v) => ({ id: v.id, created_at: v.created_at, action: v.action })),
  });
}

/**
 * Renders through the owning plugin's read view, unless the native escape hatch
 * (`?native=1`) is active. Returns null when the caller should render the
 * built-in read view instead.
 */
async function maybePluginReadView(
  c: AppContext,
  context: Omit<ReadViewContext, 'versions'> & { versions?: PageVersion[] },
): Promise<Response | null> {
  if (preferNativeEditor(c)) return null;
  return pluginReadView(c, context.pageType, {
    ...context,
    versions: (context.versions ?? []).map((v) => ({ id: v.id, created_at: v.created_at, action: v.action })),
  });
}

/**
 * Loads everything the built-in editor needs alongside a draft page row:
 * parent options, taxonomy, the current (or requested) version, recent
 * version history, which version is live, and the selected tag ids.
 */
async function editorPageData(
  c: AppContext,
  page: Page,
  parentId: string | number | null | undefined,
  requestedVersionId = NaN,
) {
  const [parentPages, taxonomy, version, versions, liveLect, pageTags, projectDraft] = await Promise.all([
    parentPageOption(c.env.DB, parentId),
    editorTaxonomy(c.env.DB),
    Number.isFinite(requestedVersionId)
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? AND id = ?')
          .bind(page.id, requestedVersionId)
          .first<PageVersion>()
      : page.current_page_version_id
      ? c.env.DB.prepare('SELECT * FROM page_versions WHERE id = ?')
          .bind(page.current_page_version_id)
          .first<PageVersion>()
      : Promise.resolve(null),
    c.env.DB.prepare('SELECT * FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
      .bind(page.id)
      .all<PageVersion>(),
    getLiveLect(c.env, page.uuid),
    c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
      .bind(page.id)
      .all<{ tag_id: number }>(),
    draftLectProjector(c.env),
  ]);

  return {
    parentPages,
    taxonomy,
    version,
    versions: versions.results,
    // The live copy is projected at publish time, so each candidate version
    // must be projected the same way before comparing (page-logic lectsMatch
    // semantics keep byte-equality for non-projected types).
    liveVersionId: versions.results.find(
      (candidate) => lectsMatch(projectDraft({ page_type: page.page_type, lect: candidate.lect }), liveLect),
    )?.id,
    isPublished: liveLect !== null,
    isLiveSynced: liveLect !== null
      && lectsMatch(projectDraft({ page_type: page.page_type, lect: page.lect }), liveLect),
    selectedTagIds: pageTags.results.map((pt) => pt.tag_id),
  };
}

async function latestPageVersionId(db: D1DatabaseClient, pageId: number): Promise<number | null> {
  const latest = await db.prepare('SELECT id FROM page_versions WHERE page_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
    .bind(pageId)
    .first<{ id: number }>();
  return latest?.id ?? null;
}

async function deletePageVersion(db: D1DatabaseClient, page: Page, versionId: number): Promise<boolean> {
  const version = await db.prepare('SELECT id FROM page_versions WHERE page_id = ? AND id = ?')
    .bind(page.id, versionId)
    .first<{ id: number }>();
  if (!version) return false;

  await db.prepare('DELETE FROM page_versions WHERE page_id = ? AND id = ?')
    .bind(page.id, versionId)
    .run();

  if (page.current_page_version_id === versionId) {
    await db.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
      .bind(await latestPageVersionId(db, page.id), page.id)
      .run();
  }

  return true;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

async function renderAllPagesList(c: AppContext, routeBase: string) {
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
  const statusParams = statusFilter ? { status: statusFilter } : {};
  const { importHref, exportHref } = await importExportHrefs(c.env);

  return renderPage(c, dashboardPage, {
    pages: draftPages.results,
    flash: flash || undefined,
    returnPath: dashboardPageHref(routeBase, draftPages.pagination.currentPage, pageSize, statusParams),
    statusFilter,
    statusFilters: statusFilterLinks(routeBase, statusFilter),
    searchAction: '/admin/advanced-search',
    advancedSearchHref: '/admin/advanced-search',
    importHref,
    exportHref,
    pagination: dashboardPagination(routeBase, draftPages, statusParams),
  });
}

pagesRoutes.get('/', async (c) => {
  const adminHome = await loadAdminHomeSettings(c.env);
  if (!new URL(c.req.url).search && adminHome.href !== '/admin') {
    return c.redirect(adminHome.href);
  }

  if (!(await userCan(c, 'content:read'))) {
    return c.text('Forbidden: insufficient permissions', 403);
  }

  return renderAllPagesList(c, '/admin');
});

// The configurable /admin home may point at a plugin dashboard. Keep this
// permanent page-list URL available for navigation and deep links.
pagesRoutes.get('/pages/list', requirePermission('content:read'), (c) => renderAllPagesList(c, '/admin/pages/list'));

pagesRoutes.get('/pages/list/:pageType', requirePermission('content:read'), async (c) => {
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
  const { importHref, exportHref } = await importExportHrefs(c.env, pageType);

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
      importHref,
      exportHref,
      pagination: dashboardPagination(routeBase, draftPages, statusParams),
      privacyTable: pageTypeHasPrivacyFields(config.blueprint[pageType]),
  });
});

pagesRoutes.get('/pages/search/:pageType', requirePermission('content:read'), async (c) => {
  const pageType = c.req.param('pageType');
  const search = c.req.query('search') ?? '';
  return c.redirect(`/admin/advanced-search/${encodeURIComponent(pageType)}?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=${encodeURIComponent(search)}&path1=`);
});

pagesRoutes.get('/pages/create_by_type/:pageType', requirePermission('content:write'), async (c) => {
  const pageType = c.req.param('pageType');
  return c.redirect(`/admin/pages/new?page_type=${encodeURIComponent(pageType)}`);
});

pagesRoutes.post('/pages/new_post/:pageType', requirePermission('content:write'), async (c) => {
  const pageType = c.req.param('pageType');
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const creator = userIdFromContext(c);
  const name = str(form.get('name')) || `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const slug = await ensureUniqueDraftSlug(c.env.DB, str(form.get('slug')) || slugify(name));
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

  const violation = await checkCreateLimits(c.env, [createCandidate(pageType, null, lect)]);
  if (violation) return c.text(limitViolationMessage(violation), 422);

  const cost = await pageCreateCostForType(c.env, pageType);
  let creditCharge: { userId: number; amount: number; action: string; source: CreditSource } | null = null;
  if (cost.total > 0) {
    const userId = Number(c.get('user').sub);
    const action = pageCreateAction(pageType, cost);
    const charge = await spendCredits(c.env, {
      userId, amount: cost.total, action, entityType: pageType, createdBy: String(userId),
    });
    if (!charge.ok) {
      return c.text(`Not enough credits: creating this needs ${charge.required} credits and you have ${charge.balance} (shared pool: ${charge.sharedBalance}).`, 402);
    }
    creditCharge = { userId, amount: cost.total, action, source: charge.source };
  }

  try {
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
  } catch (error) {
    if (creditCharge) {
      await refundCredits(c.env, {
        userId: creditCharge.userId,
        amount: creditCharge.amount,
        action: creditCharge.action,
        source: creditCharge.source,
        createdBy: String(creditCharge.userId),
      });
    }
    throw error;
  }
});

// ── New page form ─────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/new', requirePermission('content:write'), async (c) => {
  const pageType = c.req.query('page_type') || 'default';
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const lect = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const pluginView = await maybePluginNewView(c, {
    mode: 'new',
    action: '/admin/pages',
    backHref,
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
      timezone: defaultTimezone(c),
      editors: null,
      lect: stringifyLect(lect),
    },
  });
  if (pluginView) return pluginView;

  const taxonomy = await editorTaxonomy(c.env.DB);
  return renderPage(c, editorPage, {
    parentPages: [],
    tags: taxonomy.tags,
    taxonomies: taxonomy.taxonomies,
    selectedTagIds: [],
    action: withNativeFlag(c, '/admin/pages'),
    defaultPageType: pageType,
    defaultTimezone: defaultTimezone(c),
    backHref,
    structured: structuredEditorProps(config, language, lect, pageType),
  }, viewsFor(c.env));
});

// ── Create page ───────────────────────────────────────────────────────────────

pagesRoutes.post('/pages', requirePermission('content:write'), async (c) => {
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);
  const backHref = safeAdminReturnPath(form.get('return_to'));

  // Plugin-declared quotas bind the admin editor too — otherwise a "max
  // events" limit would only gate the /__cms API while the built-in create
  // form (which plugin newViews post to) walked straight past it.
  {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const parentRaw = nullableStr(form.get('page_id'));
    const lect = lectFromForm(
      config,
      pageType,
      blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
      form,
      language,
    );
    const violation = await checkCreateLimits(c.env, [
      createCandidate(pageType, parentRaw ? parseInt(parentRaw, 10) : null, lect),
    ]);
    if (violation) errors.push(limitViolationMessage(violation));
  }

  // Plugin-declared page-create costs charge the signed-in editor. Deducted
  // only when the request is otherwise valid (a validation re-render must
  // never cost credits); a failed insert below refunds.
  let creditCharge: { userId: number; amount: number; action: string; source: CreditSource } | null = null;
  if (!errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const cost = await pageCreateCostForType(c.env, pageType);
    if (cost.total > 0) {
      const userId = Number(c.get('user').sub);
      const action = pageCreateAction(pageType, cost);
      const charge = await spendCredits(c.env, {
        userId,
        amount: cost.total,
        action,
        entityType: pageType,
        createdBy: String(userId),
      });
      if (!charge.ok) {
        errors.push(charge.error === 'unknown_user'
          ? 'Your user account could not be charged credits.'
          : `Not enough credits: creating this needs ${charge.required} credits and you have ${charge.balance} (shared pool: ${charge.sharedBalance}).`);
      } else {
        creditCharge = { userId, amount: cost.total, action, source: charge.source };
      }
    }
  }

  if (errors.length) {
    const pageType = nullableStr(form.get('page_type')) ?? 'default';
    const lect = lectFromForm(
      config,
      pageType,
      blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
      form,
      language,
    );

    const pluginView = await maybePluginNewView(c, {
      mode: 'new',
      action: '/admin/pages',
      backHref,
      language,
      pageType,
      page: pluginPageFromForm(form, { id: '', name, slug, pageType }, lect, defaultTimezone(c)),
      errors,
    });
    if (pluginView) return pluginView;

    const [parentPages, taxonomy] = await Promise.all([
      parentPageOption(c.env.DB, nullableStr(form.get('page_id'))),
      editorTaxonomy(c.env.DB),
    ]);
    return renderPage(c, editorPage, {
      parentPages,
      tags: taxonomy.tags,
      taxonomies: taxonomy.taxonomies,
      selectedTagIds: [],
      errors,
      action: withNativeFlag(c, '/admin/pages'),
      defaultPageType: pageType,
      defaultTimezone: defaultTimezone(c),
      backHref,
      structured: structuredEditorProps(config, language, lect, pageType),
    }, viewsFor(c.env), 422);
  }

  const pageTypeVal = nullableStr(form.get('page_type')) ?? 'default';
  const startVal = nullableStr(form.get('start'));
  const endVal = nullableStr(form.get('end'));
  const timezoneVal = nullableStr(form.get('timezone')) ?? defaultTimezone(c);
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

  try {
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

  return c.redirect(appendQuery(backHref, 'flash=Page+created+successfully'));
  } catch (error) {
    if (creditCharge) {
      await refundCredits(c.env, {
        userId: creditCharge.userId,
        amount: creditCharge.amount,
        action: creditCharge.action,
        source: creditCharge.source,
        createdBy: String(creditCharge.userId),
      });
    }
    throw error;
  }
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

// ── Read page (read-only view) ────────────────────────────────────────────────
// Same structured content as the editor, rendered as static text instead of
// inputs. Always uses the built-in read view (plugin edit views are for editing).

pagesRoutes.get('/pages/:id/read', requirePermission('content:read'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return c.notFound();

  const data = await editorPageData(c, page, page.page_id, requestedVersionId);
  const pageType = page.page_type ?? 'default';
  const lect = lectForPage(config, pageType, data.version?.lect ?? page.lect);

  // A plugin that owns this page type's read view renders it (unless ?native=1).
  const pluginView = await maybePluginReadView(c, {
    editHref: `/admin/pages/${pageId}/edit`,
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
    versions: data.versions,
  });
  if (pluginView) return pluginView;

  const modifierName = await fetchUserName(c.env.DB, num(lect._modifier, 0));

  return renderPage(c, readPage, {
    page: { ...page, lect: stringifyLect(lect) },
    modifierName: modifierName ?? undefined,
    version: data.version ?? undefined,
    isVersionPreview: Number.isFinite(requestedVersionId) && !!data.version,
    liveVersionId: data.liveVersionId,
    parentPages: data.parentPages,
    tags: data.taxonomy.tags,
    taxonomies: data.taxonomy.taxonomies,
    selectedTagIds: data.selectedTagIds,
    backHref,
    structured: structuredEditorProps(config, language, lect, pageType, data.versions),
  });
});

// ── Edit page form ────────────────────────────────────────────────────────────

pagesRoutes.get('/pages/:id/edit', requirePermission('content:read'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, undefined, config);
  const requestedVersionId = parseInt(c.req.query('version') ?? '', 10);
  const flash = c.req.query('flash') ?? '';
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(pageId).first<Page>();
  if (!page) return c.notFound();

  const data = await editorPageData(c, page, page.page_id, requestedVersionId);
  const pageType = page.page_type ?? 'default';
  const lect = lectForPage(config, pageType, data.version?.lect ?? page.lect);

  const pluginView = await maybePluginEditView(c, {
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
    versions: data.versions,
    flash: flash || undefined,
  });
  if (pluginView) return pluginView;

  const [creatorName, modifierName] = await Promise.all([
    fetchUserName(c.env.DB, page.creator),
    fetchUserName(c.env.DB, num(lect._modifier, 0)),
  ]);

  return renderPage(c, editorPage, {
    page: { ...page, lect: stringifyLect(lect) },
    creatorName: creatorName ?? undefined,
    modifierName: modifierName ?? undefined,
    version: data.version ?? undefined,
    isVersionPreview: Number.isFinite(requestedVersionId) && !!data.version,
    liveVersionId: data.liveVersionId,
    isPublished: data.isPublished,
    isLiveSynced: data.isLiveSynced,
    parentPages: data.parentPages,
    tags: data.taxonomy.tags,
    taxonomies: data.taxonomy.taxonomies,
    selectedTagIds: data.selectedTagIds,
    flash: flash || undefined,
    action: withNativeFlag(c, `/admin/pages/${pageId}`),
    backHref,
    defaultTimezone: defaultTimezone(c),
    // Current draft lect, so a version preview can diff against it.
    draftLect: stringifyLect(lectForPage(config, pageType, page.lect)),
    structured: structuredEditorProps(config, language, lect, pageType, data.versions),
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

  const flash = result.success ? 'flash=Draft+weight+updated' : 'flash=Weight+update+failed';
  return c.redirect(appendQuery(returnPath, flash));
});

// ── Update page ───────────────────────────────────────────────────────────────

pagesRoutes.post('/pages/:id', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const form = await c.req.formData();
  const config = await resolveCmsConfig(c.env);
  const language = languageFromRequest(c, form, config);
  const action = str(form.get('action'));
  const backHref = safeAdminReturnPath(form.get('return_to'));

  const name = str(form.get('name'));
  const slug = str(form.get('slug'));
  const errors = validatePageBasics(name, slug);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return c.notFound();

  if (action.startsWith('delete-version:')) {
    const versionId = parseInt(action.split(':')[1], 10);
    if (!Number.isFinite(versionId)) return c.notFound();
    const deleted = await deletePageVersion(c.env.DB, page, versionId);
    if (!deleted) return c.notFound();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Version+removed`);
  }

  if (action === 'delete-versions') {
    await c.env.DB.prepare('DELETE FROM page_versions WHERE page_id = ?')
      .bind(pageId)
      .run();
    await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = NULL WHERE id = ?')
      .bind(pageId)
      .run();
    return c.redirect(`/admin/pages/${pageId}/edit?flash=Versions+cleaned`);
  }


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
    const data = await editorPageData(c, page, nullableStr(form.get('page_id')) ?? page.page_id);
    const pageType = nullableStr(form.get('page_type')) ?? page.page_type ?? 'default';
    const lect = lectFromForm(config, pageType, lectForPage(config, pageType, page.lect), form, language);

    const pluginView = await maybePluginEditView(c, {
      mode: 'edit',
      action: `/admin/pages/${pageId}`,
      backHref,
      language,
      pageType,
      page: pluginPageFromForm(form, { id: pageId, name, slug, pageType }, lect, page.timezone),
      versions: data.versions,
      errors,
    });
    if (pluginView) return pluginView;

    return renderPage(c, editorPage, {
      page,
      version: data.version ?? undefined,
      liveVersionId: data.liveVersionId,
      isPublished: data.isPublished,
      isLiveSynced: data.isLiveSynced,
      parentPages: data.parentPages,
      tags: data.taxonomy.tags,
      taxonomies: data.taxonomy.taxonomies,
      selectedTagIds: data.selectedTagIds,
      errors,
      action: withNativeFlag(c, `/admin/pages/${pageId}`),
      backHref,
      defaultTimezone: defaultTimezone(c),
      structured: structuredEditorProps(config, language, lect, pageType, data.versions),
    }, viewsFor(c.env), 422);
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

  // Preserve where the editor returns to (e.g. a plugin dashboard) across saves,
  // so the back arrow / Cancel button still point there after a save reload.
  const returnToParam = backHref !== '/admin' ? `&return_to=${encodeURIComponent(backHref)}` : '';
  // Keep the built-in-editor override across the post-save reload.
  const nativeParam = preferNativeEditor(c) ? '&native=1' : '';

  const autoRepublish = action !== 'publish'
    && await pluginAutoPublishesPageType(c.env, pageTypeVal)
    && !!await c.env.PUBLISHED_DB.prepare('SELECT 1 FROM live_pages WHERE uuid = ?')
      .bind(page.uuid)
      .first();

  if (action === 'publish' || autoRepublish) {
    const outcome = await publishPageToTargets(c.env, pageId);
    if (!outcome) return c.notFound();
    if (!outcome.refused) dispatchHook(c, 'publish', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });
    if (action === 'publish') {
      return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}&flash=${publishFlash(outcome)}${returnToParam}${nativeParam}`);
    }
  }

  if (isStructuredEditorAction(action)) {
    return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}${returnToParam}${nativeParam}`);
  }

  if (!autoRepublish) dispatchHook(c, 'update', { id: pageId, uuid: page.uuid, page_type: pageTypeVal, name, slug: uniqueSlug });

  const savedFlash = autoRepublish ? 'Page+updated+and+published+successfully' : 'Page+updated+successfully';
  return c.redirect(`/admin/pages/${pageId}/edit?language=${encodeURIComponent(language)}&flash=${savedFlash}${returnToParam}${nativeParam}`);
});

// ── Publish (DRAFT → PUBLISHED) ───────────────────────────────────────────────

pagesRoutes.post('/pages/:id/publish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));
  const outcome = await publishPageToTargets(c.env, pageId);
  if (!outcome) return c.notFound();

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!outcome.refused) {
    dispatchHook(c, 'publish', {
      id: pageId,
      uuid: page?.uuid,
      name: page?.name,
      slug: page?.slug,
      page_type: page?.page_type,
    });
  }

  return c.redirect(appendQuery(backHref, `flash=${publishFlash(outcome)}`));
});

// ── Pull published page (PUBLISHED → DRAFT) ───────────────────────────────────

pagesRoutes.post('/pages/pull/:uuid', requirePermission('content:write'), async (c) => {
  const result = await pullPublishedPageToDraft(c.env.DB, c.env.PUBLISHED_DB, c.req.param('uuid'));
  if (!result) return c.notFound();

  if (result.created) {
    dispatchHook(c, 'submission', {
      id: result.page.id,
      uuid: result.page.uuid,
      page_type: result.page.page_type,
      name: result.page.name,
      slug: result.page.slug,
    });
  }

  const flash = result.created ? 'Published+page+pulled+to+draft' : 'Draft+already+exists';
  return c.redirect(`/admin/pages/${result.page.id}/edit?flash=${flash}`);
});

// ── Unpublish (remove from published DB) ──────────────────────────────────────

pagesRoutes.post('/pages/:id/unpublish', requirePermission('content:publish'), async (c) => {
  const pageId = parseInt(c.req.param('id'), 10);
  const backHref = safeAdminReturnPath(c.req.query('return_to'));

  const page = await c.env.DB.prepare('SELECT uuid, name, slug, page_type FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ uuid: string; name: string; slug: string; page_type: string | null }>();
  if (!page) return c.notFound();

  await unpublishPageFromTargets(c.env, page.uuid, await isSubmissionMirror(c.env.DB, pageId));

  dispatchHook(c, 'unpublish', {
    id: pageId,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect(appendQuery(backHref, 'flash=Page+unpublished'));
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
  await unpublishPageFromTargets(c.env, page.uuid, !!page.submission_origin);

  dispatchHook(c, 'delete', {
    id: page.id,
    uuid: page.uuid,
    name: page.name,
    slug: page.slug,
    page_type: page.page_type,
  });

  return c.redirect('/admin?flash=Page+moved+to+trash');
});
