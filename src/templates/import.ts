import importTemplate from '../views/templates/import.liquid';
import { layout } from './layout';
import { renderLiquid } from './liquid';

export function importPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pageType: string;
}): string {
  const { siteTitle, userName, userRole, userAvatar, pageType } = opts;
  const body = renderLiquid(importTemplate, {
    pageType,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
  });

  return layout({
    title: 'Import',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
