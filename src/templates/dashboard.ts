import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { Page } from '../types';

export interface DashboardPage extends Page {
  isPublished: boolean;
  contentPreview?: string;
  liveWeight?: number;
  hasLiveWeightDrift?: boolean;
  hasLiveLectDrift?: boolean;
}

interface DashboardPagination {
  total: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  firstHref: string;
  previousHref: string;
  nextHref: string;
  lastHref: string;
}

interface DashboardStatusFilterLink {
  label: string;
  href: string;
  isActive: boolean;
}

export async function dashboardPage(views: Fetcher, opts: BaseTemplateProps & {
  pages: DashboardPage[];
  flash?: string;
  returnPath?: string;
  pageTypeFilter?: string;
  statusFilter?: '' | 'draft' | 'live';
  statusFilters?: DashboardStatusFilterLink[];
  privacyTable?: boolean;
  searchValue?: string;
  searchAction?: string;
  advancedSearchHref?: string;
  importHref?: string;
  exportHref?: string;
  pagination?: DashboardPagination;
}): Promise<string> {
  const {
    pages,
    flash,
    returnPath = '/admin',
    pageTypeFilter,
    statusFilter = '',
    statusFilters = [],
    searchValue = '',
    searchAction = '/admin',
    advancedSearchHref = pageTypeFilter ? `/admin/advanced-search/${encodeURIComponent(pageTypeFilter)}` : '/admin/advanced-search',
    importHref = pageTypeFilter ? `/admin/pages/import-v2/${encodeURIComponent(pageTypeFilter)}` : '',
    exportHref = pageTypeFilter ? `/admin/pages/export/${encodeURIComponent(pageTypeFilter)}` : '/admin/pages/export',
    pagination,
  } = opts;
  const pageCount = pagination?.total ?? pages.length;
  const paginationStart = pagination && pageCount > 0
    ? ((pagination.currentPage - 1) * pagination.pageSize) + 1
    : pages.length ? 1 : 0;
  const paginationEnd = pagination
    ? Math.min(pageCount, paginationStart + pages.length - 1)
    : pages.length;
  const showPageTypeColumn = !pageTypeFilter;
  const countSubject = statusFilter === 'live'
    ? 'live page'
    : statusFilter === 'draft'
      ? 'draft page'
      : 'page';
  const countSuffix = pageCount === 1 ? '' : 's';
  const pageCountLabel = pagination && pageCount > 0
    ? `Showing ${paginationStart}-${paginationEnd} of ${pageCount} ${countSubject}${countSuffix}${statusFilter ? '' : ' in draft'}`
    : `${pageCount} ${countSubject}${countSuffix}${statusFilter ? '' : ' in draft'}`;
  const body = await renderView(views, '/templates/dashboard.json', {
    flash,
    hasFlash: !!flash,
    returnPath,
    pageTitle: pageTypeFilter ? `Pages: ${pageTypeFilter}` : 'Pages',
    showPageTypeColumn,
    privacyTable: !!opts.privacyTable,
    emptyColspan: showPageTypeColumn ? 5 : 4,
    searchValue,
    searchAction,
    searchPlaceholder: pageTypeFilter ? `Search ${pageTypeFilter} pages` : 'Search pages',
    statusFilter,
    hasStatusFilters: statusFilters.length > 0,
    statusFilters,
    advancedSearchHref,
    importHref,
    hasImportHref: !!importHref,
    exportHref,
    hasExportHref: !!exportHref,
    pageCount,
    pageCountLabel,
    hasPages: pages.length > 0,
    showPagination: !!pagination && pagination.totalPages > 1,
    currentPage: pagination?.currentPage ?? 1,
    totalPages: pagination?.totalPages ?? 1,
    hasFirstPage: !!pagination?.firstHref,
    hasPreviousPage: !!pagination?.previousHref,
    hasNextPage: !!pagination?.nextHref,
    hasLastPage: !!pagination?.lastHref,
    firstHref: pagination?.firstHref ?? '',
    previousHref: pagination?.previousHref ?? '',
    nextHref: pagination?.nextHref ?? '',
    lastHref: pagination?.lastHref ?? '',
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType: page.page_type ?? '-',
      pageTypeHref: showPageTypeColumn && page.page_type ? `/admin/pages/list/${encodeURIComponent(page.page_type)}` : '',
      weight: page.weight,
      liveWeight: page.liveWeight,
      hasLiveWeightDrift: !!page.hasLiveWeightDrift,
      hasLiveLectDrift: !!page.hasLiveLectDrift,
      isPublished: page.isPublished,
      weightAction: `/admin/pages/${page.id}/weight`,
      editHref: `/admin/pages/${page.id}/edit`,
      publishAction: `/admin/pages/${page.id}/publish`,
      unpublishAction: `/admin/pages/${page.id}/unpublish`,
      deleteAction: `/admin/pages/${page.id}/delete`,
    })),
  });

  return adminLayout(views, opts, { title: 'Dashboard', body });
}
