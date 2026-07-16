import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { Page } from '../types';

export interface DashboardPage extends Page {
  isPublished: boolean;
  isDraftMissing?: boolean;
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
  translationKey?: string;
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
    // Import/export live in the import-export plugin; empty hrefs hide the buttons.
    importHref = '',
    exportHref = '',
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
    pageTypeFilter: pageTypeFilter ?? '',
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
    paginatedCount: !!pagination && pageCount > 0,
    paginationStart,
    paginationEnd,
    singularCount: pageCount === 1,
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
      isDraftMissing: !!page.isDraftMissing,
      isPublished: page.isPublished,
      weightAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/weight`,
      editHref: page.isDraftMissing ? '' : `/admin/pages/${page.id}/edit`,
      readHref: page.isDraftMissing ? '' : `/admin/pages/${page.id}/read`,
      publishAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/publish`,
      unpublishAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/unpublish`,
      deleteAction: page.isDraftMissing ? '' : `/admin/pages/${page.id}/delete`,
      pullAction: `/admin/pages/pull/${encodeURIComponent(page.uuid)}`,
    })),
  });

  return adminLayout(views, opts, { title: 'Dashboard', body });
}
