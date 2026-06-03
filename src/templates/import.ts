import { layout, escHtml } from './layout';

export function importPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pageType: string;
}): string {
  const { siteTitle, userName, userRole, userAvatar, pageType } = opts;
  const body = `
    <div class="px-8 py-8 max-w-3xl">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-2xl font-bold text-gray-900">Import ${escHtml(pageType)}</h2>
        <a href="/admin/pages/list/${encodeURIComponent(pageType)}" class="text-sm text-indigo-600 hover:underline">Back</a>
      </div>
      <form method="POST" class="space-y-4">
        <textarea name="items" rows="18"
                  placeholder='[{"name":"Example","slug":"example","values":{"en":{"name":"Example"}}}]'
                  class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono"></textarea>
        <button type="submit" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg">Import</button>
      </form>
    </div>`;

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
