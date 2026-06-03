import { layout, escHtml } from './layout';
import { tagFormScript } from './scripts';
import type { Tag, TagType } from '../types';

export function tagsPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagTypes: TagType[];
  tags: Tag[];
  filterTagType: number;
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagTypes, tags, filterTagType } = opts;
  const tagTypeMap = new Map(tagTypes.map((type) => [type.id, type.name]));
  const filterOptions = tagTypes
    .map((type) => `<option value="${type.id}" ${filterTagType === type.id ? 'selected' : ''}>${escHtml(type.name)}</option>`)
    .join('');
  const rows = tags.map((tag) => `
      <tr class="hover:bg-gray-50">
        <td class="px-6 py-3 text-sm font-medium text-gray-900">${escHtml(tag.name)}</td>
        <td class="px-6 py-3 text-sm font-mono text-gray-500">${escHtml(tag.slug)}</td>
        <td class="px-6 py-3 text-sm text-gray-500">${escHtml(tag.tag_type_id ? tagTypeMap.get(tag.tag_type_id) ?? '' : '')}</td>
        <td class="px-6 py-3 text-right">
          <a href="/admin/tags/${tag.id}/edit" class="text-sm font-medium text-indigo-600 hover:text-indigo-800">Edit</a>
        </td>
      </tr>`)
    .join('');
  const body = `
    <div class="px-8 py-8">
      <div class="flex items-center justify-between mb-6">
        <h2 class="text-2xl font-bold text-gray-900">Tags</h2>
        <div class="flex items-center gap-2">
          <a href="/admin/tag-types" class="px-4 py-2 bg-white text-gray-700 text-sm font-semibold rounded-lg border border-gray-300">Tag Types</a>
          <a href="/admin/tags/new" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg">New Tag</a>
        </div>
      </div>
      <form method="GET" class="mb-4 flex items-center gap-2">
        <select name="filter_tag_type" class="px-3 py-2 border border-gray-300 rounded-lg text-sm">
          <option value="0">All tag types</option>
          ${filterOptions}
        </select>
        <button type="submit" class="px-3 py-2 border border-gray-300 rounded-lg text-sm font-semibold">Filter</button>
      </form>
      <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <table class="w-full text-left">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Name</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Slug</th>
              <th class="px-6 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
              <th class="px-6 py-3"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${rows || '<tr><td colspan="4" class="px-6 py-10 text-center text-gray-400">No tags yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  return layout({
    title: 'Tags',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export function tagFormPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tag?: Tag;
  language: string;
  languages: string[];
  translatedName: string;
  translatedPlaceholder: string;
  tagTypes: TagType[];
  parentTags: Tag[];
}): string {
  const {
    siteTitle,
    userName,
    userRole,
    userAvatar,
    tag,
    language,
    languages,
    translatedName,
    translatedPlaceholder,
    tagTypes,
    parentTags,
  } = opts;
  const languageOptions = languages
    .map((lang) => `<option value="${escHtml(lang)}" ${lang === language ? 'selected' : ''}>${escHtml(lang)}</option>`)
    .join('');
  const tagTypeOptions = tagTypes
    .map((type) => `<option value="${type.id}" ${tag?.tag_type_id === type.id ? 'selected' : ''}>${escHtml(type.name)}</option>`)
    .join('');
  const parentOptions = parentTags
    .filter((candidate) => candidate.id !== tag?.id)
    .map((candidate) => `<option value="${candidate.id}" ${tag?.parent_tag === candidate.id ? 'selected' : ''}>${escHtml(candidate.name)}</option>`)
    .join('');
  const action = tag ? `/admin/tags/${tag.id}` : '/admin/tags';
  const deleteButton = tag
    ? `<form method="POST" action="/admin/tags/${tag.id}/delete">
         <button type="submit" class="px-4 py-2 text-sm font-semibold text-red-600">Delete</button>
       </form>`
    : '';
  const body = `
    <div class="px-8 py-8 max-w-xl">
      <h2 class="text-2xl font-bold text-gray-900 mb-6">${tag ? 'Edit' : 'New'} Tag</h2>
      <form method="POST" action="${action}" class="space-y-4">
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Language</span>
          <select name="_language"
                  onchange="switchTagLanguage(this.value)"
                  class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            ${languageOptions}
          </select>
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Name</span>
          <input id="tag_name" name="name" required value="${escHtml(tag?.name ?? '')}"
                 oninput="autoTagSlug(this.value)"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Translated Name</span>
          <input name=".name|${escHtml(language)}"
                 value="${escHtml(translatedName)}"
                 placeholder="${escHtml(translatedPlaceholder)}"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Slug</span>
          <input id="tag_slug" name="slug" value="${escHtml(tag?.slug ?? '')}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Tag Type</span>
          <select name="tag_type_id" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="">None</option>
            ${tagTypeOptions}
          </select>
        </label>
        <label class="block">
          <span class="block text-sm font-medium text-gray-700 mb-1">Parent Tag</span>
          <select name="parent_tag" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
            <option value="">None</option>
            ${parentOptions}
          </select>
        </label>
        <div class="flex items-center gap-3">
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg">Save</button>
          <a href="/admin/tags" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-semibold">Cancel</a>
        </div>
      </form>
      ${deleteButton}
    </div>
    ${tagFormScript({ isEdit: !!tag })}`;

  return layout({
    title: tag ? 'Edit Tag' : 'New Tag',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
