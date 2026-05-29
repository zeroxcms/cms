// ============================================================
// Admin dashboard template – lists pages from DRAFT DB
// with live publish status indicators
// ============================================================

import { layout, escHtml } from './layout';
import type { Page } from '../types';

export interface DashboardPage extends Page {
  isPublished: boolean;
  contentPreview?: string;
}

export function dashboardPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pages: DashboardPage[];
  flash?: string;
}): string {
  const { siteTitle, userName, userRole, userAvatar, pages, flash } = opts;

  const flashBanner = flash
    ? `<div id="flash" class="mb-4 rounded-lg bg-green-50 border border-green-200 p-3 text-sm text-green-700 flex items-center gap-2">
        <svg class="w-4 h-4 text-green-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
        </svg>
        ${escHtml(flash)}
       </div>`
    : '';

  const tableRows = pages.length
    ? pages
        .map(
          (p) => `
        <tr class="hover:bg-gray-50 transition-colors">
          <td class="px-6 py-4">
            <div class="font-medium text-gray-900">${escHtml(p.name)}</div>
            <div class="text-sm text-gray-500 font-mono">/${escHtml(p.slug)}</div>
          </td>
          <td class="px-6 py-4 text-sm text-gray-500">${escHtml(p.page_type ?? '—')}</td>
          <td class="px-6 py-4 text-sm text-gray-500">${p.weight}</td>
          <td class="px-6 py-4">
            ${
              p.isPublished
                ? `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
                     <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>Live
                   </span>`
                : `<span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                     <span class="w-1.5 h-1.5 rounded-full bg-yellow-500"></span>Draft
                   </span>`
            }
          </td>
          <td class="px-6 py-4">
            <div class="flex items-center gap-2">
              <a href="/admin/pages/${p.id}/edit"
                 class="text-indigo-600 hover:text-indigo-800 text-sm font-medium">Edit</a>
              ${
                p.isPublished
                  ? `<form method="POST" action="/admin/pages/${p.id}/unpublish" class="inline"
                          onsubmit="return confirm('Unpublish this page?')">
                       <button type="submit"
                               class="text-yellow-600 hover:text-yellow-800 text-sm font-medium">Unpublish</button>
                     </form>`
                  : `<form method="POST" action="/admin/pages/${p.id}/publish" class="inline">
                       <button type="submit"
                               class="text-green-600 hover:text-green-800 text-sm font-medium">Publish</button>
                     </form>`
              }
              <form method="POST" action="/admin/pages/${p.id}/delete" class="inline"
                    onsubmit="return confirm('Delete this page permanently?')">
                <button type="submit"
                        class="text-red-500 hover:text-red-700 text-sm font-medium">Delete</button>
              </form>
            </div>
          </td>
        </tr>`,
        )
        .join('')
    : `<tr>
        <td colspan="5" class="px-6 py-12 text-center text-gray-400">
          <svg class="w-12 h-12 mx-auto mb-3 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
          </svg>
          No pages yet. <a href="/admin/pages/new" class="text-indigo-600 hover:underline">Create your first page</a>.
        </td>
       </tr>`;

  const body = `
    <div class="px-8 py-8">
      <div class="flex items-center justify-between mb-6">
        <div>
          <h2 class="text-2xl font-bold text-gray-900">Pages</h2>
          <p class="text-sm text-gray-500 mt-1">${pages.length} page${pages.length !== 1 ? 's' : ''} in draft</p>
        </div>
        <a href="/admin/pages/new"
           class="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors shadow-sm">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
          New Page
        </a>
      </div>

      ${flashBanner}

      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Page</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Weight</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>

    <script>
      // Auto-dismiss flash message after 4 seconds
      const flash = document.getElementById('flash');
      if (flash) setTimeout(() => flash.remove(), 4000);
    </script>`;

  return layout({
    title: 'Dashboard',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
