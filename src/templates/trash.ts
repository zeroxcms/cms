import { layout, escHtml } from './layout';
import { dismissFlashScript } from './scripts';
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
  const flashBanner = flash
    ? `<div id="flash" class="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700">${escHtml(flash)}</div>`
    : '';

  const tableRows = pages.length
    ? pages.map((p) => `
        <tr class="hover:bg-gray-50 transition-colors">
          <td class="px-6 py-4">
            <div class="font-medium text-gray-900">${escHtml(p.name)}</div>
            <div class="text-sm text-gray-500 font-mono">/${escHtml(p.slug)}</div>
          </td>
          <td class="px-6 py-4 text-sm text-gray-500">${escHtml(p.page_type ?? '-')}</td>
          <td class="px-6 py-4 text-sm text-gray-400">${escHtml(p.updated_at)}</td>
          <td class="px-6 py-4">
            <div class="flex items-center gap-2">
              <form method="POST" action="/admin/trash/${p.id}/restore" class="inline">
                <button type="submit"
                        class="text-indigo-600 hover:text-indigo-800 text-sm font-medium">Restore</button>
              </form>
              <form method="POST" action="/admin/trash/${p.id}/delete" class="inline"
                    onsubmit="return confirm('Permanently delete this page? This cannot be undone.')">
                <button type="submit"
                        class="text-red-500 hover:text-red-700 text-sm font-medium">Delete Forever</button>
              </form>
            </div>
          </td>
        </tr>`)
      .join('')
    : `<tr>
        <td colspan="4" class="px-6 py-12 text-center text-gray-400">Trash is empty.</td>
       </tr>`;

  const body = `
    <div class="px-8 py-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-2xl font-bold text-gray-900">Trash</h2>
          <p class="text-sm text-gray-500 mt-1">${pages.length} page${pages.length !== 1 ? 's' : ''} in trash</p>
        </div>
        <a href="/admin" class="text-sm text-indigo-600 hover:underline">Back to Pages</a>
      </div>

      ${flashBanner}

      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Page</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Deleted</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>
    ${dismissFlashScript()}`;

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
