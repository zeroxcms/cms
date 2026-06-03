import trashTemplate from '../views/templates/trash.liquid';
import { layout } from './layout';
import { renderLiquid } from './liquid';
import type { Page } from '../types';

export function trashPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pages: Page[];
  flash?: string;
}): string {
  const { siteTitle, userName, userRole, userAvatar, pages, flash } = opts;
  const pageCount = pages.length;
  const body = renderLiquid(trashTemplate, {
    flash,
    hasFlash: !!flash,
    pageCountLabel: `${pageCount} page${pageCount === 1 ? '' : 's'} in trash`,
    hasPages: pageCount > 0,
    pages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      slug: page.slug,
      pageType: page.page_type ?? '-',
      updatedAt: page.updated_at,
      restoreAction: `/admin/trash/${page.id}/restore`,
      deleteAction: `/admin/trash/${page.id}/delete`,
    })),
  });

  return layout({
    title: 'Trash',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
