import { layout, escHtml } from './layout';
import type { TagType } from '../types';

export function tagTypesPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagTypes: TagType[];
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagTypes } = opts;
  const rows = tagTypes.map((t) => `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-3 text-sm font-medium text-gray-900">${escHtml(t.name)}</td>
        <td class="px-6 py-3 text-sm font-mono text-gray-500">${escHtml(t.slug)}</td>
        <td class="px-6 py-3 text-right">
          <a href="/admin/tag-types/${t.id}/edit" class="text-sm font-medium text-indigo-600 hover:text-indigo-800">Edit</a>
        </td>
      </tr>`)
    .join('');

  const body = `
    <div class="px-8 py-8">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-2xl font-bold text-gray-900">Tag Types</h2>
        <a href="/admin/tag-types/new" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg">New Tag Type</a>
      </div>
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Slug</th>
              <th class="px-6 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${rows || '<tr><td colspan="3" class="px-6 py-10 text-center text-gray-400">No tag types yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  return layout({
    title: 'Tag Types',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export function tagTypeFormPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagType?: TagType;
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagType } = opts;
  const action = tagType ? `/admin/tag-types/${tagType.id}` : '/admin/tag-types';
  const deleteButton = tagType
    ? `<form method="POST" action="/admin/tag-types/${tagType.id}/delete">
         <button type="submit" class="px-4 py-2 text-sm font-semibold text-red-600">Delete</button>
       </form>`
    : '';
  const body = `
    <div class="px-8 py-8 max-w-xl">
      <h2 class="text-2xl font-bold text-gray-900 mb-6">${tagType ? 'Edit' : 'New'} Tag Type</h2>
      <form method="POST" action="${action}" class="space-y-4">
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Name</span>
          <input name="name" required value="${escHtml(tagType?.name ?? '')}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Slug</span>
          <input name="slug" value="${escHtml(tagType?.slug ?? '')}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </label>
        <div class="flex items-center gap-3">
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg">Save</button>
          <a href="/admin/tag-types" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-semibold">Cancel</a>
        </div>
      </form>
      ${deleteButton}
    </div>`;

  return layout({
    title: tagType ? 'Edit Tag Type' : 'New Tag Type',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
