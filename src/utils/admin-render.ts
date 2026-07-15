// Shared template-prop builders and CSV/list export responses for the admin routes.

import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppContext } from './context';
import { advancedSearchPage } from '../templates/advanced-search';
import { dashboardPageHref, num, userIdFromContext } from './forms';
import {
  advancedSearchFormCriteria,
  advancedSearchOperator,
  advancedSearchOrder,
  advancedSearchPageSize,
  advancedSearchPageTypes,
  advancedSearchPathOptionsByPageType,
  advancedSearchQueryString,
  advancedSearchSelectedPageType,
  advancedSearchSort,
  advancedSearchTagGroups,
  advancedSearchTargetPageTypes,
  parseAdvancedSearchCriteria,
  performAdvancedSearch,
} from './search';
import { resolveCmsConfig } from '../plugins/config';
import { pluginById, pluginNav } from '../plugins/registry';
import { editorTaxonomy, fetchUserAvatar } from './admin-queries';
import { getCreditBalance, getSharedCreditBalance } from './credits';
import { listLiveByTypes } from '../publish';
import { draftLectProjector } from '../publish/projection';
import type { DashboardListResult } from './admin-queries';
import { withLiveStatus } from './page-logic';
import { effectivePermissions, resolveRolePermissions } from './roles';
import type { Permission } from '../types';
import { viewRevision } from './view-revision';
import { mintFormOnceToken } from './form-once';
import {
  SIDEBAR_MENU_ITEMS,
  defaultPluginNavWeight,
  loadAppBrandingSettings,
  loadSidebarChromeSettings,
  pluginSidebarKey,
  type SidebarMenuItemKey,
} from './settings';

export type { BaseTemplateProps } from '../templates/layout';
import type { BaseTemplateProps, SidebarNavItem } from '../templates/layout';
import { withActiveSidebarItems } from './sidebar';

/** The signed-in user's effective permission set (built-in defaults + DB overrides). */
export async function userPermissions(c: AppContext): Promise<Set<Permission>> {
  const map = await resolveRolePermissions(c.env);
  return effectivePermissions(map, c.get('user').role);
}

/** Convenience check used by routes to decide read-only vs editable rendering. */
export async function userCan(c: AppContext, permission: Permission): Promise<boolean> {
  return (await userPermissions(c)).has(permission);
}

/**
 * Builds the template props shared by every authenticated admin page:
 * site title, signed-in user's name/role, avatar, and plugin nav. Handlers
 * spread the result and add page-specific fields (and may override siteTitle).
 */
export async function buildBaseProps(c: AppContext): Promise<BaseTemplateProps> {
  const user = c.get('user');
  const userRoles = user.role.split(',').map((role) => role.trim()).filter(Boolean);
  const fallbackSiteTitle = c.env.SITE_TITLE ?? '0xCMS';
  const [userAvatar, navItems, permissions, branding, userCredits, sharedCredits, cmsOnce] = await Promise.all([
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    pluginNav(c.env),
    userPermissions(c),
    loadAppBrandingSettings(c.env, fallbackSiteTitle),
    getCreditBalance(c.env, userIdFromContext(c)),
    getSharedCreditBalance(c.env),
    mintFormOnceToken(c.env.JWT_SECRET),
  ]);
  const sidebarSettings = await loadSidebarChromeSettings(c.env);
  const menuSettings = sidebarSettings.items;
  const visible = navItems
    .filter((item) => !item.roles?.length || item.roles.some((role) => userRoles.includes(role)));
  const toLink = (item: { label: string; href: string }) => ({ label: item.label, href: item.href });
  // Plugins may target the Settings group (group: 'settings'); everything else
  // sits at the top level of the sidebar.
  const nav = visible.filter((item) => item.group !== 'settings').map(toLink);
  const settingsNav = visible.filter((item) => item.group === 'settings').map(toLink);
  const canSeeMenuItem = (key: SidebarMenuItemKey): boolean => {
    if (key === 'users') return permissions.has('users:manage');
    if (key === 'roles') return permissions.has('roles:manage');
    if (key === 'plugins') return permissions.has('plugin:manage');
    if (key === 'system') return permissions.has('menu:manage');
    return true;
  };
  const orderedSidebarItems = SIDEBAR_MENU_ITEMS
    .map((item, index) => ({ item, index, setting: menuSettings[item.key] }))
    .filter((entry) => entry.setting.visible && canSeeMenuItem(entry.item.key))
    .sort((a, b) => a.setting.weight - b.setting.weight || a.index - b.index);
  const sidebarSettingsNavEntries: Array<{ item: SidebarNavItem; weight: number; index: number }> = orderedSidebarItems
    .filter((entry) => entry.item.group === 'settings')
    .map((entry) => ({
      item: {
        label: entry.item.label,
        href: entry.item.href,
        icon: entry.item.icon,
      },
      weight: entry.setting.weight,
      index: entry.index,
    }));
  const sidebarNavEntries: Array<{ item: SidebarNavItem; weight: number; index: number }> = orderedSidebarItems
    .filter((entry) => entry.item.group === 'main')
    .map((entry) => ({
      item: {
        label: entry.item.label,
        href: entry.item.href,
        icon: entry.item.icon,
      },
      weight: entry.setting.weight,
      index: entry.index,
    }));
  visible.forEach((item, index) => {
    const key = pluginSidebarKey(item);
    if (sidebarSettings.hiddenPluginKeys.has(key)) return;
    const entry = {
      item: {
        label: item.label,
        href: item.href,
        icon: 'beaker',
      },
      weight: sidebarSettings.pluginWeights[key] ?? defaultPluginNavWeight(item.group),
      index: SIDEBAR_MENU_ITEMS.length + index,
    };
    if (item.group === 'settings') sidebarSettingsNavEntries.push(entry);
    else sidebarNavEntries.push(entry);
  });
  const unorderedSidebarSettingsNav = sidebarSettingsNavEntries
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.item);
  if (unorderedSidebarSettingsNav.length > 0) {
    sidebarNavEntries.push({
      item: {
        label: 'Settings',
        href: '',
        icon: 'settings',
        isSettingsGroup: true,
      },
      weight: sidebarSettings.settingsGroupWeight,
      index: SIDEBAR_MENU_ITEMS.length,
    });
  }
  const unorderedSidebarNav = sidebarNavEntries
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.item);
  const { sidebarNav, sidebarSettingsNav } = withActiveSidebarItems(
    c.req.path,
    unorderedSidebarNav,
    unorderedSidebarSettingsNav,
    c.req.query('return_to'),
  );
  return {
    siteTitle: branding.appName,
    appIcon: branding.appIcon,
    userName: user.name,
    userRole: user.role,
    userAvatar: userAvatar ?? '',
    userCredits: userCredits ?? 0,
    sharedCredits,
    currentUserId: String(user.sub),
    pluginNav: nav,
    pluginSettingsNav: settingsNav,
    viewRevision: viewRevision(c.env),
    cmsOnce,
    canManageUsers: permissions.has('users:manage'),
    canManageRoles: permissions.has('roles:manage'),
    canManagePlugins: permissions.has('plugin:manage'),
    canManageMenu: permissions.has('menu:manage'),
    sidebarNav,
    sidebarSettingsNav,
    showSidebarPages: menuSettings.pages.visible,
    showSidebarTags: menuSettings.tags.visible,
    showSidebarTaxonomies: menuSettings.taxonomies.visible,
    showSidebarPageTypes: menuSettings.pageTypes.visible,
    showSidebarBlockTypes: menuSettings.blockTypes.visible,
    showSidebarUsers: menuSettings.users.visible,
    showSidebarRoles: menuSettings.roles.visible,
    showSidebarPlugins: menuSettings.plugins.visible,
    showSidebarMenu: menuSettings.system.visible,
    showSidebarTrash: menuSettings.trash.visible,
  };
}

/**
 * Renders an admin page template with the shared base props pre-filled.
 * `extra` supplies the page-specific fields and may override base props
 * (e.g. a page-specific siteTitle). `views` defaults to env.VIEWS; pass
 * viewsFor(env) for templates that resolve plugin-owned snippets.
 * `status` overrides the 200 default (e.g. 422 validation re-renders).
 */
export async function renderPage<P extends BaseTemplateProps>(
  c: AppContext,
  page: (views: Fetcher, props: P) => Promise<string>,
  extra: Omit<P, keyof BaseTemplateProps> & Partial<BaseTemplateProps>,
  views: Fetcher = c.env.VIEWS,
  status?: ContentfulStatusCode,
): Promise<Response> {
  const base = await buildBaseProps(c);
  const html = await page(views, { ...base, ...extra } as unknown as P);
  return status ? c.html(html, status) : c.html(html);
}

export function dashboardPagination(
  routeBase: string,
  result: DashboardListResult,
  params: Record<string, string | number | null | undefined> = {},
) {
  const { currentPage, totalPages, limit } = result.pagination;

  return {
    total: result.pagination.total,
    totalPages,
    currentPage,
    pageSize: limit,
    firstHref: currentPage > 1 ? dashboardPageHref(routeBase, 1, limit, params) : '',
    previousHref: currentPage > 1 ? dashboardPageHref(routeBase, currentPage - 1, limit, params) : '',
    nextHref: currentPage < totalPages ? dashboardPageHref(routeBase, currentPage + 1, limit, params) : '',
    lastHref: currentPage < totalPages ? dashboardPageHref(routeBase, totalPages, limit, params) : '',
  };
}

/** Manifest id of the plugin that owns CSV import/export since its extraction. */
export const IMPORT_EXPORT_PLUGIN_ID = 'import-export';

/** The plugin's admin base path when it is registered and enabled, else ''. */
export async function importExportPluginBase(env: AppContext['env']): Promise<string> {
  const plugin = await pluginById(env, IMPORT_EXPORT_PLUGIN_ID);
  return plugin ? `/admin/plugins/${IMPORT_EXPORT_PLUGIN_ID}` : '';
}

/**
 * Dashboard Import/Export button targets. CSV import/export moved into the
 * import-export plugin — the buttons deep-link there when it's installed and
 * disappear (empty hrefs) when it isn't.
 */
export async function importExportHrefs(
  env: AppContext['env'],
  pageType?: string,
): Promise<{ importHref: string; exportHref: string }> {
  const base = await importExportPluginBase(env);
  if (!base) return { importHref: '', exportHref: '' };
  return {
    importHref: pageType ? `${base}/import/${encodeURIComponent(pageType)}` : base,
    exportHref: pageType ? `${base}/export?page_type=${encodeURIComponent(pageType)}` : `${base}/export`,
  };
}

export async function renderAdvancedSearch(c: AppContext, defaultPageType = 'all', canSelectPageType = true) {
  const config = await resolveCmsConfig(c.env);
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const selectedPageType = canSelectPageType
    ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType, config)
    : advancedSearchSelectedPageType(undefined, defaultPageType, config);
  const pageTypes = advancedSearchTargetPageTypes(selectedPageType, config);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const pageSize = advancedSearchPageSize(c.req.query('pagesize'));
  const requestedPage = Math.max(num(c.req.query('page'), 1), 1);
  const sort = advancedSearchSort(c.req.query('sort'));
  const order = advancedSearchOrder(c.req.query('order'));
  const hasSearch = criteria.length > 0;

  const taxonomy = await editorTaxonomy(c.env.DB);

  const result = hasSearch
    ? await performAdvancedSearch(c.env.DB, pageTypes, criteria, operator, {
        limit: pageSize,
        page: requestedPage,
        sort,
        order,
      })
    : {
        results: [],
        pagination: {
          total: 0,
          totalPages: 1,
          currentPage: requestedPage,
          limit: pageSize,
        },
      };

  const [livePages, projectDraft] = await Promise.all([
    listLiveByTypes(c.env, pageTypes),
    draftLectProjector(c.env),
  ]);
  const liveMap = new Map(livePages.map((page) => [page.uuid, page]));
  const routeBase = selectedPageType === 'all'
    ? '/admin/advanced-search'
    : `/admin/advanced-search/${encodeURIComponent(selectedPageType)}`;
  // CSV export lives in the import-export plugin now; the button only shows
  // when that plugin is registered and enabled.
  const exportBase = (await importExportPluginBase(c.env))
    ? `/admin/plugins/${IMPORT_EXPORT_PLUGIN_ID}/export-search?page_type=${encodeURIComponent(selectedPageType)}`
    : '';
  const queryWithoutPage = advancedSearchQueryString(criteria, operator, pageSize, { sort, order });
  const pageQuery = (page: number) => advancedSearchQueryString(criteria, operator, pageSize, {
    sort,
    order,
    page,
  });
  const maxCriterionIndex = criteria.reduce((max, criterion) => Math.max(max, criterion.index), 0);
  const pathOptionsByPageType = advancedSearchPathOptionsByPageType(config);

  return renderPage(c, advancedSearchPage, {
      siteTitle: `${c.env.SITE_TITLE ?? '0xCMS'} · Advanced Search`,
      pageTitle: selectedPageType === 'all' ? 'Advanced Search' : `Advanced Search: ${selectedPageType}`,
      pageType: selectedPageType,
      canSelectPageType,
      pageTypes: advancedSearchPageTypes(config).map((pageType) => ({
        value: pageType,
        label: pageType,
        selected: pageType === selectedPageType,
      })),
      routeBase,
      criteria: advancedSearchFormCriteria(criteria, taxonomy.taxonomies, taxonomy.tags),
      tagGroups: advancedSearchTagGroups(taxonomy.taxonomies, taxonomy.tags),
      pathOptions: pathOptionsByPageType[selectedPageType] ?? pathOptionsByPageType.all,
      pathOptionsByPageTypeJson: JSON.stringify(pathOptionsByPageType),
      nextCriterionIndex: Math.max(2, maxCriterionIndex + 1),
      operator,
      pageSize,
      sort,
      order,
      hasSearch,
      count: result.pagination.total,
      currentPage: result.pagination.currentPage,
      totalPages: result.pagination.totalPages,
      previousHref: result.pagination.currentPage > 1 ? `${routeBase}?${pageQuery(result.pagination.currentPage - 1)}` : '',
      nextHref: result.pagination.currentPage < result.pagination.totalPages ? `${routeBase}?${pageQuery(result.pagination.currentPage + 1)}` : '',
      resetHref: routeBase,
      exportHref: exportBase ? `${exportBase}&${queryWithoutPage}` : '',
      hasExportHref: !!exportBase,
      bulkAction: `${routeBase}/bulk?${queryWithoutPage}`,
      currentHref: `${routeBase}?${pageQuery(result.pagination.currentPage)}`,
      queryWithoutPage,
      pages: withLiveStatus(result.results, liveMap, projectDraft),
  });
}
