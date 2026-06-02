// ============================================================
// Page editor template – create or edit a page
// ============================================================

import { layout, escHtml } from './layout';
import type { Page, PageVersion, Tag } from '../types';
import type { BlueprintProps, Original, OriginalItem } from '../utils/original';
import type { CmsConfig } from '../cms-config';

function renderStructuredEditor(opts: {
  config: CmsConfig;
  language: string;
  original: Original;
  blueprintProps: BlueprintProps;
  blockProps: Record<string, BlueprintProps>;
  blockNames: string[];
  versions: PageVersion[];
}): string {
  const { config, language, original, blueprintProps, blockProps, blockNames } = opts;
  const languageOptions = config.languages
    .map((lang) => `<option value="${escHtml(lang)}" ${lang === language ? 'selected' : ''}>${escHtml(lang)}</option>`)
    .join('');
  const blockOptions = blockNames
    .map((name) => `<option value="${escHtml(name)}">${escHtml(name)}</option>`)
    .join('');

  return `
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-5">
      <div class="flex items-center justify-between gap-4">
        <p class="text-sm font-semibold text-gray-700">Structured Content</p>
        <label class="flex items-center gap-2 text-xs text-gray-500">
          Language
          <select name="_language" class="px-2 py-1 border border-gray-300 rounded-lg text-xs">
            ${languageOptions}
          </select>
        </label>
      </div>
      ${renderOriginalFields('', original, blueprintProps, language, config.defaultLanguage)}
      <div class="border-t border-gray-100 pt-5 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <p class="text-sm font-semibold text-gray-700">Blocks</p>
          ${
            blockOptions
              ? `<div class="flex items-center gap-2">
                   <select name="block-select" class="px-2 py-1 border border-gray-300 rounded-lg text-xs">${blockOptions}</select>
                   <button type="submit" name="action" value="block-add"
                           class="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-semibold">Add Block</button>
                 </div>`
              : ''
          }
        </div>
        ${
          original.blocks.length
            ? original.blocks
                .map((block, index) => {
                  const type = block.attributes._type || 'default';
                  return `<div class="rounded-lg border border-gray-200 p-4 space-y-4">
                            <div class="flex items-center justify-between gap-3">
                              <p class="text-xs font-semibold uppercase tracking-wide text-gray-500">${escHtml(type)}</p>
                              <button type="submit" name="action" value="block-delete:${index}"
                                      class="text-xs font-semibold text-red-600 hover:text-red-700">Delete Block</button>
                            </div>
                            <input type="hidden" name="#${index}@_type" value="${escHtml(type)}">
                            <input type="hidden" name="#${index}@_id" value="${escHtml(block.attributes._id ?? '')}">
                            ${renderOriginalFields(`#${index}`, block, blockProps[type] ?? blockProps.default, language, config.defaultLanguage)}
                          </div>`;
                })
                .join('')
            : '<p class="text-sm text-gray-400">No blocks yet.</p>'
        }
      </div>
    </div>`;
}

function renderOriginalFields(
  prefix: string,
  original: Original | OriginalItem,
  props: BlueprintProps,
  language: string,
  defaultLanguage: string,
): string {
  const attributeFields = props.attributes
    .map((field) =>
      renderInput(`${prefix}@${field.name}`, field.name, original.attributes[field.name] ?? '', field.type),
    )
    .join('');
  const pointerFields = props.pointers
    .map((field) =>
      renderInput(`${prefix}*${field.name}`, `${field.name} reference`, original.pointers[field.name] ?? '', field.type),
    )
    .join('');
  const valueFields = props.fields
    .map((field) =>
      renderInput(
        `${prefix}.${field.name}|${language}`,
        field.name,
        original.values[language]?.[field.name] ?? original.values[defaultLanguage]?.[field.name] ?? '',
        field.type,
      ),
    )
    .join('');
  const itemFields = props.items
    .map((item) => renderItemGroup(prefix, item, original.items[item.name] ?? [], language, defaultLanguage))
    .join('');

  return `
    <div class="grid grid-cols-2 gap-5">
      ${attributeFields}
      ${pointerFields}
      ${valueFields}
    </div>
    ${itemFields}`;
}

function renderItemGroup(
  prefix: string,
  props: NonNullable<BlueprintProps['items'][number]>,
  items: OriginalItem[],
  language: string,
  defaultLanguage: string,
): string {
  const rows = items.length ? items : [];
  const blockMatch = prefix.match(/^#(\d+)/);
  const addAction = blockMatch ? `block-item-add:${blockMatch[1]}|${props.name}` : `item-add:${props.name}`;
  return `
    <div class="rounded-lg border border-gray-100 bg-gray-50 p-4 space-y-4">
      <div class="flex items-center justify-between">
        <p class="text-sm font-semibold text-gray-700">${escHtml(props.name)}</p>
        <button type="submit" name="action" value="${escHtml(addAction)}"
                class="px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-xs font-semibold text-gray-700">Add Item</button>
      </div>
      ${
        rows.length
          ? rows
              .map((item, index) => {
                const itemPrefix = `${prefix}.${props.name}[${index}]`;
                const nestedProps: BlueprintProps = {
                  attributes: props.attributes,
                  pointers: props.pointers,
                  fields: props.fields,
                  items: props.items ?? [],
                };
                const deleteAction = blockMatch
                  ? `block-item-delete:${blockMatch[1]}|${props.name}|${index}`
                  : `item-delete:${props.name}|${index}`;
                return `<div class="rounded-lg bg-white border border-gray-200 p-4 space-y-3">
                          <div class="flex items-center justify-between">
                            <span class="text-xs text-gray-400">Item ${index + 1}</span>
                            <button type="submit" name="action" value="${escHtml(deleteAction)}"
                                    class="text-xs font-semibold text-red-600 hover:text-red-700">Delete</button>
                          </div>
                          ${renderOriginalFields(itemPrefix, item, nestedProps, language, defaultLanguage)}
                        </div>`;
              })
              .join('')
          : '<p class="text-sm text-gray-400">No items yet.</p>'
      }
    </div>`;
}

function renderInput(name: string, label: string, value: string, type: string): string {
  const isLong = type.includes('textarea') || label === 'body' || label === 'description';
  const input = isLong
    ? `<textarea name="${escHtml(name)}" rows="4"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(value)}</textarea>`
    : `<input type="${type === 'date' ? 'date' : 'text'}" name="${escHtml(name)}"
              value="${escHtml(value)}"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">`;

  return `<label class="${isLong ? 'col-span-2' : ''} block">
            <span class="block text-sm font-medium text-gray-700 mb-1">${escHtml(label)}</span>
            ${input}
          </label>`;
}

export function editorPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  page?: Page;
  version?: PageVersion;
  parentPages: Page[];
  tags: Tag[];
  selectedTagIds: number[];
  errors?: string[];
  action: string;
  defaultPageType?: string;
  structured?: {
    config: CmsConfig;
    language: string;
    original: Original;
    blueprintProps: BlueprintProps;
    blockProps: Record<string, BlueprintProps>;
    blockNames: string[];
    versions: PageVersion[];
  };
}): string {
  const {
    siteTitle,
    userName,
    userRole,
    userAvatar,
    page,
    version,
    parentPages,
    tags,
    selectedTagIds,
    errors = [],
    action,
    defaultPageType = '',
    structured,
  } = opts;

  const isEdit = !!page;
  const pageTitle = isEdit ? `Edit: ${page.name}` : 'New Page';

  const errorBlock = errors.length
    ? `<div class="mb-6 rounded-lg bg-red-50 border border-red-200 p-4">
        <p class="text-sm font-semibold text-red-700 mb-1">Please fix the following errors:</p>
        <ul class="list-disc list-inside text-sm text-red-600">
          ${errors.map((e) => `<li>${escHtml(e)}</li>`).join('')}
        </ul>
       </div>`
    : '';

  const parentOptions = parentPages
    .filter((p) => p.id !== page?.id)
    .map(
      (p) =>
        `<option value="${p.id}" ${page?.page_id === p.id ? 'selected' : ''}>${escHtml(p.name)}</option>`,
    )
    .join('');

  const tagCheckboxes = tags
    .map(
      (t) =>
        `<label class="flex items-center gap-2 cursor-pointer">
           <input type="checkbox" name="tag_ids" value="${t.id}"
                  ${selectedTagIds.includes(t.id) ? 'checked' : ''}
                  class="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500">
           <span class="text-sm text-gray-700">${escHtml(t.name)}</span>
         </label>`,
    )
    .join('');

  const structuredBlock = structured
    ? renderStructuredEditor(structured)
    : '';
  const versionHrefBase = page ? `/admin/pages/${page.id}/edit` : action;

  const versionBlock = structured?.versions.length
    ? `<div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <p class="text-sm font-semibold text-gray-700 mb-3">Versions</p>
        <div class="flex flex-wrap gap-2">
          ${structured.versions
            .map((v) => {
              const label = `${v.created_at}${v.action ? ` · ${v.action}` : ''}`;
              return `<a href="${escHtml(versionHrefBase)}?version=${v.id}"
                         class="px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-xs text-gray-700 hover:bg-gray-50">${escHtml(label)}</a>
                      <button type="submit" name="action" value="revert:${v.id}"
                              class="px-3 py-1.5 rounded-lg border border-yellow-300 bg-yellow-50 text-xs text-yellow-800 hover:bg-yellow-100">Revert</button>`;
            })
            .join('')}
        </div>
       </div>`
    : '';

  const body = `
    <div class="px-8 py-8 max-w-4xl">
      <div class="flex items-center gap-3 mb-6">
        <a href="/admin" class="text-gray-400 hover:text-gray-600 transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </a>
        <h2 class="text-2xl font-bold text-gray-900">${escHtml(pageTitle)}</h2>
      </div>

      ${errorBlock}

      <form method="POST" action="${escHtml(action)}" class="space-y-6">
        <!-- Main fields -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-5">
          <div class="grid grid-cols-2 gap-5">
            <div class="col-span-2">
              <label for="name" class="block text-sm font-medium text-gray-700 mb-1">
                Page Name <span class="text-red-500">*</span>
              </label>
              <input type="text" id="name" name="name" required
                     value="${escHtml(page?.name ?? '')}"
                     placeholder="My Awesome Page"
                     class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                     oninput="autoSlug(this.value)">
            </div>

            <div class="col-span-2">
              <label for="slug" class="block text-sm font-medium text-gray-700 mb-1">
                Slug <span class="text-red-500">*</span>
              </label>
              <div class="flex items-center">
                <span class="px-3 py-2 bg-gray-50 border border-r-0 border-gray-300 rounded-l-lg text-sm text-gray-500">/</span>
                <input type="text" id="slug" name="slug" required
                       value="${escHtml(page?.slug ?? '')}"
                       placeholder="my-awesome-page"
                       class="flex-1 px-3 py-2 border border-gray-300 rounded-r-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
              </div>
            </div>

            <div>
              <label for="page_type" class="block text-sm font-medium text-gray-700 mb-1">Page Type</label>
              <input type="text" id="page_type" name="page_type"
                     value="${escHtml(page?.page_type ?? defaultPageType)}"
                     placeholder="e.g. blog, product, landing"
                     class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
            </div>

            <div>
              <label for="weight" class="block text-sm font-medium text-gray-700 mb-1">Sort Weight</label>
              <input type="number" id="weight" name="weight"
                     value="${page?.weight ?? 5}" min="0" max="100"
                     class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
            </div>

            <div>
              <label for="start" class="block text-sm font-medium text-gray-700 mb-1">Publish From</label>
              <input type="datetime-local" id="start" name="start"
                     value="${page?.start ? page.start.replace(' ', 'T').slice(0, 16) : ''}"
                     class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
            </div>

            <div>
              <label for="end" class="block text-sm font-medium text-gray-700 mb-1">Publish Until</label>
              <input type="datetime-local" id="end" name="end"
                     value="${page?.end ? page.end.replace(' ', 'T').slice(0, 16) : ''}"
                     class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
            </div>

            <div class="col-span-2">
              <label for="page_id" class="block text-sm font-medium text-gray-700 mb-1">Parent Page</label>
              <select id="page_id" name="page_id"
                      class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">
                <option value="">— None (top-level page) —</option>
                ${parentOptions}
              </select>
            </div>

            <div class="col-span-2">
              <label for="original_json" class="block text-sm font-medium text-gray-700 mb-1">Original JSON</label>
              <textarea id="original_json" name="original_json" rows="4"
                        class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(page?.original ?? '')}</textarea>
            </div>
          </div>
        </div>

        ${structuredBlock}

        <!-- Content editor -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <label for="content" class="block text-sm font-medium text-gray-700 mb-2">Content</label>
          <!-- Toolbar -->
          <div class="flex items-center gap-1 mb-2 p-2 bg-gray-50 border border-b-0 border-gray-300 rounded-t-lg">
            <button type="button" onclick="insertTag('h2')"
                    class="px-2 py-1 text-xs font-bold text-gray-600 hover:bg-gray-200 rounded" title="Heading">H2</button>
            <button type="button" onclick="insertTag('h3')"
                    class="px-2 py-1 text-xs font-bold text-gray-600 hover:bg-gray-200 rounded" title="Sub-heading">H3</button>
            <span class="w-px h-4 bg-gray-300 mx-1"></span>
            <button type="button" onclick="wrapSelection('strong')"
                    class="px-2 py-1 text-xs font-bold text-gray-600 hover:bg-gray-200 rounded" title="Bold"><b>B</b></button>
            <button type="button" onclick="wrapSelection('em')"
                    class="px-2 py-1 text-xs italic font-bold text-gray-600 hover:bg-gray-200 rounded" title="Italic"><i>I</i></button>
            <span class="w-px h-4 bg-gray-300 mx-1"></span>
            <button type="button" onclick="insertTag('p')"
                    class="px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 rounded" title="Paragraph">¶</button>
            <button type="button" onclick="insertList('ul')"
                    class="px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 rounded" title="Unordered list">• List</button>
            <button type="button" onclick="insertList('ol')"
                    class="px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 rounded" title="Ordered list">1. List</button>
            <button type="button" onclick="insertLink()"
                    class="px-2 py-1 text-xs text-gray-600 hover:bg-gray-200 rounded" title="Link">Link</button>
          </div>
          <textarea id="content" name="content" rows="16"
                    placeholder="Enter HTML content here..."
                    class="w-full px-3 py-2 border border-gray-300 rounded-b-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(version?.content ?? '')}</textarea>
          <p class="text-xs text-gray-400 mt-1">Content is saved as HTML.</p>
        </div>

        <!-- Meta / JSON -->
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <label for="meta" class="block text-sm font-medium text-gray-700 mb-1">
            Meta (JSON)
            <span class="text-gray-400 font-normal">– SEO title, description, og:image, etc.</span>
          </label>
          <textarea id="meta" name="meta" rows="4"
                    placeholder='{"title": "...", "description": "...", "og_image": "..."}'
                    class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(version?.meta ?? '')}</textarea>
        </div>

        <!-- Tags -->
        ${
          tags.length
            ? `<div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <p class="text-sm font-medium text-gray-700 mb-3">Tags</p>
                <div class="flex flex-wrap gap-3">
                  ${tagCheckboxes}
                </div>
               </div>`
            : ''
        }

        ${versionBlock}

        <!-- Actions -->
        <div class="flex items-center gap-3 pt-2">
          <button type="submit"
                  class="px-6 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg hover:bg-indigo-700 transition-colors shadow-sm">
            ${isEdit ? 'Save Changes' : 'Create Page'}
          </button>
          ${
            isEdit
              ? `<button type="submit" name="action" value="publish"
                         class="px-6 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 transition-colors shadow-sm">Publish</button>`
              : ''
          }
          <a href="/admin" class="px-6 py-2 bg-white text-gray-700 text-sm font-semibold rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors">
            Cancel
          </a>
        </div>
      </form>
    </div>

    <script>
      // Auto-generate slug from page name
      let slugEdited = ${isEdit ? 'true' : 'false'};
      document.getElementById('slug').addEventListener('input', () => { slugEdited = true; });

      function autoSlug(name) {
        if (slugEdited) return;
        const slug = name.toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        document.getElementById('slug').value = slug;
      }

      // Simple HTML insertion helpers
      function insertTag(tag) {
        const ta = document.getElementById('content');
        const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd) || 'Content here';
        const insert = '<' + tag + '>' + sel + '</' + tag + '>';
        replaceSelection(ta, insert);
      }

      function wrapSelection(tag) {
        const ta = document.getElementById('content');
        const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd);
        if (!sel) return;
        replaceSelection(ta, '<' + tag + '>' + sel + '</' + tag + '>');
      }

      function insertList(type) {
        const ta = document.getElementById('content');
        const insert = '<' + type + '>\\n  <li>Item 1</li>\\n  <li>Item 2</li>\\n</' + type + '>';
        replaceSelection(ta, insert);
      }

      function insertLink() {
        const url = prompt('URL:', 'https://');
        if (!url) return;
        const ta = document.getElementById('content');
        const text = ta.value.substring(ta.selectionStart, ta.selectionEnd) || 'Link text';
        replaceSelection(ta, '<a href="' + url + '">' + text + '</a>');
      }

      function replaceSelection(ta, text) {
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        ta.value = ta.value.substring(0, start) + text + ta.value.substring(end);
        ta.selectionStart = ta.selectionEnd = start + text.length;
        ta.focus();
      }

      // Validate meta JSON on submit
      document.querySelector('form').addEventListener('submit', (e) => {
        const metaEl = document.getElementById('meta');
        if (metaEl.value.trim()) {
          try { JSON.parse(metaEl.value); } catch(err) {
            e.preventDefault();
            alert('Meta field contains invalid JSON: ' + err.message);
          }
        }
      });
    </script>`;

  return layout({
    title: pageTitle,
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
