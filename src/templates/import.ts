import { layout } from './layout';
import { renderLiquid } from './liquid';

export async function importPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pageType: string;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, pageType } = opts;
  const body = await renderLiquid(views, '/templates/import.liquid', {
    pageType,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
  });

  return layout(views, {
    title: 'Import',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
