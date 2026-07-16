import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { Page } from '../types';

interface TrashPagination {
  total: number;
  totalPages: number;
  currentPage: number;
  firstHref: string;
  previousHref: string;
  nextHref: string;
  lastHref: string;
}

interface TypeCount {
  pageType: string;
  count: number;
}

export async function trashPage(views: Fetcher, opts: BaseTemplateProps & {
  pages: Page[];
  flash?: string;
  pagination?: TrashPagination;
  total?: number;
  grandTotal?: number;
  filterType?: string;
  typeCounts?: TypeCount[];
  recentCount?: number;
  canPurgeTrash?: boolean;
}): Promise<string> {
  const { pages, flash, pagination, total = pages.length, typeCounts = [], recentCount = 0, filterType = '', canPurgeTrash = false } = opts;
  const grandTotal = opts.grandTotal ?? total;
  const showPagination = (pagination?.totalPages ?? 1) > 1;
  const typeSuffix = filterType ? `${filterType} ` : '';
  const body = await renderView(views, '/templates/trash.json', {
    flash,
    hasFlash: !!flash,
    pageCountLabel: `${total} ${typeSuffix}page${total === 1 ? '' : 's'} in trash`,
    singularCount: total === 1,
    hasPages: total > 0,
    anyTrash: grandTotal > 0,
    emptyTrashAction: '/admin/trash/empty',
    restoreAllAction: '/admin/trash/restore',
    typeCounts,
    hasTypeFilter: typeCounts.length > 0,
    filterType,
    grandTotal,
    recentCount,
    hasRecent: recentCount > 0,
    total,
    canPurgeTrash,
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType: page.page_type ?? '-',
      updatedAt: page.updated_at,
      restoreAction: `/admin/trash/${page.id}/restore`,
      deleteAction: `/admin/trash/${page.id}/delete`,
    })),
    showPagination,
    ...(showPagination && pagination ? {
      currentPage: pagination.currentPage,
      totalPages: pagination.totalPages,
      hasFirstPage: !!pagination.firstHref,
      firstHref: pagination.firstHref,
      hasPreviousPage: !!pagination.previousHref,
      previousHref: pagination.previousHref,
      hasNextPage: !!pagination.nextHref,
      nextHref: pagination.nextHref,
      hasLastPage: !!pagination.lastHref,
      lastHref: pagination.lastHref,
    } : {}),
  });

  return adminLayout(views, opts, { title: 'Trash', body });
}
