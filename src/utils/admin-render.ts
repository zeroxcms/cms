// Shared template-prop builders and CSV/list export responses for the admin routes.

import type { AppContext } from './context';
import { advancedSearchPage } from '../templates/advanced-search';
import { dashboardPageHref, num } from './forms';
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
  uniqueSorted,
} from './search';
import { csvDownloadResponse, exportPagesCsv } from './csv';
import { resolveCmsConfig } from '../plugins/config';
import { pluginNav } from '../plugins/registry';
import { editorTaxonomy, fetchUserAvatar } from './admin-queries';
import type { DashboardListResult } from './admin-queries';
import { lectsMatch } from './page-logic';
import { strParam } from './forms';
import type { Page } from '../types';

export interface BaseTemplateProps {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  currentUserId: string;
  /** Navigation entries contributed by active plugins, filtered to the user's roles. */
  pluginNav: Array<{ label: string; href: string }>;
}

/**
 * Builds the template props shared by every authenticated admin page:
 * site title, signed-in user's name/role, avatar, and plugin nav. Handlers
 * spread the result and add page-specific fields (and may override siteTitle).
 */
export async function buildBaseProps(c: AppContext, userAvatar: string | null): Promise<BaseTemplateProps> {
  const user = c.get('user');
  const userRoles = user.role.split(',').map((role) => role.trim()).filter(Boolean);
  const nav = (await pluginNav(c.env))
    .filter((item) => !item.roles?.length || item.roles.some((role) => userRoles.includes(role)))
    .map((item) => ({ label: item.label, href: item.href }));
  return {
    siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    userName: user.name,
    userRole: user.role,
    userAvatar: userAvatar ?? '',
    currentUserId: String(user.sub),
    pluginNav: nav,
  };
}

export function dashboardPagination(routeBase: string, result: DashboardListResult) {
  const { currentPage, totalPages, limit } = result.pagination;

  return {
    total: result.pagination.total,
    totalPages,
    currentPage,
    pageSize: limit,
    firstHref: currentPage > 1 ? dashboardPageHref(routeBase, 1, limit) : '',
    previousHref: currentPage > 1 ? dashboardPageHref(routeBase, currentPage - 1, limit) : '',
    nextHref: currentPage < totalPages ? dashboardPageHref(routeBase, currentPage + 1, limit) : '',
    lastHref: currentPage < totalPages ? dashboardPageHref(routeBase, totalPages, limit) : '',
  };
}

export async function exportPageList(c: AppContext, pageType?: string): Promise<Response> {
  const config = await resolveCmsConfig(c.env);
  const selectedPageType = strParam(pageType);
  const pages = selectedPageType
    ? await c.env.DB.prepare(
        'SELECT * FROM draft_pages WHERE page_type = ? ORDER BY weight ASC, name ASC',
      )
        .bind(selectedPageType)
        .all<Page>()
    : await c.env.DB.prepare(
        'SELECT * FROM draft_pages ORDER BY page_type ASC, weight ASC, name ASC',
      ).all<Page>();
  const pageTypes = selectedPageType
    ? [selectedPageType]
    : uniqueSorted([
        ...advancedSearchPageTypes(config),
        ...pages.results.map((page) => page.page_type ?? ''),
      ]);
  const csv = await exportPagesCsv(c.env.DB, pages.results, pageTypes, config);
  const stamp = c.req.query('r') || new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${selectedPageType || 'pages'}-export-${stamp}.csv`;

  return csvDownloadResponse(csv, filename);
}

export async function exportAdvancedSearch(c: AppContext, defaultPageType = 'all', canSelectPageType = true): Promise<Response> {
  const config = await resolveCmsConfig(c.env);
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const selectedPageType = canSelectPageType
    ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType, config)
    : advancedSearchSelectedPageType(undefined, defaultPageType, config);
  const pageTypes = advancedSearchTargetPageTypes(selectedPageType, config);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const sort = advancedSearchSort(c.req.query('sort'));
  const order = advancedSearchOrder(c.req.query('order'));
  const result = criteria.length
    ? await performAdvancedSearch(c.env.DB, pageTypes, criteria, operator, {
        limit: 10000,
        page: 1,
        sort,
        order,
      })
    : {
        results: [],
        pagination: {
          total: 0,
          totalPages: 1,
          currentPage: 1,
          limit: 10000,
        },
      };
  const csv = await exportPagesCsv(c.env.DB, result.results, pageTypes, config);
  const stamp = c.req.query('r') || new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${selectedPageType === 'all' ? 'pages' : selectedPageType}-export-${stamp}.csv`;

  return csvDownloadResponse(csv, filename);
}

export async function renderAdvancedSearch(c: AppContext, defaultPageType = 'all', canSelectPageType = true) {
  const config = await resolveCmsConfig(c.env);
  const user = c.get('user');
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

  const [taxonomy, userAvatar] = await Promise.all([
    editorTaxonomy(c.env.DB),
    fetchUserAvatar(c.env.DB, parseInt(user.sub, 10)),
  ]);

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

  const pageTypePlaceholders = pageTypes.map(() => '?').join(',');
  const livePages = await c.env.PUBLISHED_DB.prepare(`SELECT uuid, lect, weight FROM live_pages WHERE page_type IN (${pageTypePlaceholders})`)
    .bind(...pageTypes)
    .all<{ uuid: string; lect: string | null; weight: number }>();
  const liveMap = new Map(livePages.results.map((page) => [page.uuid, page]));
  const routeBase = selectedPageType === 'all'
    ? '/admin/advanced-search'
    : `/admin/advanced-search/${encodeURIComponent(selectedPageType)}`;
  const exportBase = selectedPageType === 'all'
    ? '/admin/advanced-search-export'
    : `/admin/advanced-search-export/${encodeURIComponent(selectedPageType)}`;
  const queryWithoutPage = advancedSearchQueryString(criteria, operator, pageSize, { sort, order });
  const pageQuery = (page: number) => advancedSearchQueryString(criteria, operator, pageSize, {
    sort,
    order,
    page,
  });
  const maxCriterionIndex = criteria.reduce((max, criterion) => Math.max(max, criterion.index), 0);
  const pathOptionsByPageType = advancedSearchPathOptionsByPageType(config);

  return c.html(
    await advancedSearchPage(c.env.VIEWS, {
      ...(await buildBaseProps(c, userAvatar)),
      siteTitle: `${c.env.SITE_TITLE ?? 'Worker CMS'} · Advanced Search`,
      pageTitle: selectedPageType === 'all' ? 'Advanced Search' : `Advanced Search: ${selectedPageType}`,
      pageType: selectedPageType,
      canSelectPageType,
      pageTypes: advancedSearchPageTypes(config).map((pageType) => ({
        value: pageType,
        label: pageType,
        selected: pageType === selectedPageType,
      })),
      routeBase,
      criteria: advancedSearchFormCriteria(criteria, taxonomy.tagTypes, taxonomy.tags),
      tagGroups: advancedSearchTagGroups(taxonomy.tagTypes, taxonomy.tags),
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
      exportHref: `${exportBase}?${queryWithoutPage}`,
      queryWithoutPage,
      pages: result.results.map((page) => ({
        ...page,
        isPublished: liveMap.has(page.uuid),
        liveWeight: liveMap.get(page.uuid)?.weight,
        hasLiveWeightDrift: liveMap.has(page.uuid) && liveMap.get(page.uuid)?.weight !== page.weight,
        hasLiveLectDrift: liveMap.has(page.uuid) && !lectsMatch(liveMap.get(page.uuid)?.lect, page.lect),
      })),
    }),
  );
}
