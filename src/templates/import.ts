import { layout } from './layout';
import { renderView } from './liquid';

export async function importPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pageType: string;
  mode?: 'json' | 'csv';
  action?: string;
  sampleHeaders?: string[];
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, pageType, mode = 'json', action = '', sampleHeaders = [] } = opts;
  const body = await renderView(views, '/templates/import.json', {
    pageType,
    action,
    backHref: `/admin/pages/list/${encodeURIComponent(pageType)}`,
    isCsvImport: mode === 'csv',
    sampleCsvHeader: sampleHeaders.join(','),
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
