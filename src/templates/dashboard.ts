import { layout } from './layout';
import { renderView } from './liquid';
import type { Page } from '../types';

export interface DashboardPage extends Page {
  isPublished: boolean;
  contentPreview?: string;
  liveWeight?: number;
  hasLiveWeightDrift?: boolean;
  hasLiveLectDrift?: boolean;
}

export async function dashboardPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pages: DashboardPage[];
  flash?: string;
  returnPath?: string;
  pageTypeFilter?: string;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, pages, flash, returnPath = '/admin', pageTypeFilter } = opts;
  const pageCount = pages.length;
  const showPageTypeColumn = !pageTypeFilter;
  const body = await renderView(views, '/templates/dashboard.json', {
    flash,
    hasFlash: !!flash,
    returnPath,
    pageTitle: pageTypeFilter ? `Pages: ${pageTypeFilter}` : 'Pages',
    showPageTypeColumn,
    emptyColspan: showPageTypeColumn ? 5 : 4,
    pageCount,
    pageCountLabel: `${pageCount} page${pageCount === 1 ? '' : 's'} in draft`,
    hasPages: pageCount > 0,
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

  return layout(views, {
    title: 'Dashboard',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
