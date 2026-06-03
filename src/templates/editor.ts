import { layout, escHtml } from './layout';
import { renderLiquid, renderView } from './liquid';
import type { Page, PageVersion, Tag } from '../types';
import {
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  getLectPointer,
  getLectScalar,
} from '../utils/lect';
import type { BlueprintProps, Lect, LectItem } from '../utils/lect';
import type { CmsConfig } from '../cms-config';

async function renderStructuredEditor(views: Fetcher, opts: {
  config: CmsConfig;
  language: string;
  lect: Lect;
  blueprintProps: BlueprintProps;
  blockProps: Record<string, BlueprintProps>;
  blockNames: string[];
  versions: PageVersion[];
}): Promise<string> {
  const { config, language, lect, blueprintProps, blockProps, blockNames } = opts;
  const blocks = getLectBlocks(lect).map((block, index) => {
    const type = String(block._type || 'default');
    return {
      index,
      type,
      id: block._id ?? '',
      deleteAction: `block-delete:${index}`,
      fieldsHtml: renderLectFields(
        `#${index}`,
        block,
        blockProps[type] ?? blockProps.default,
        language,
        config.defaultLanguage,
      ),
    };
  });

  return renderLiquid(views, '/snippets/structured-editor.liquid', {
    languageOptions: config.languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    fieldsHtml: renderLectFields('', lect, blueprintProps, language, config.defaultLanguage),
    blockOptions: blockNames.map((name) => ({ value: name })),
    hasBlockOptions: blockNames.length > 0,
    hasBlocks: blocks.length > 0,
    blocks,
  });
}

function renderLectFields(
  prefix: string,
  lect: Lect | LectItem,
  props: BlueprintProps,
  language: string,
  defaultLanguage: string,
): string {
  const attributeFields = props.attributes
    .map((field) =>
      renderInput(`${prefix}@${field.name}`, fieldLabel(field.name), getLectScalar(lect, field.name), field.type),
    )
    .join('');
  const pointerFields = props.pointers
    .map((field) =>
      renderInput(`${prefix}*${field.name}`, `${fieldLabel(field.name)} reference`, getLectPointer(lect, field.name), field.type),
    )
    .join('');
  const valueFields = props.fields
    .map((field) =>
      renderInput(
        `${prefix}.${field.name}|${language}`,
        fieldLabel(field.name),
        getLectLocalizedValue(lect, field.name, language),
        field.type,
        language === defaultLanguage ? '' : getLectLocalizedValue(lect, field.name, defaultLanguage),
      ),
    )
    .join('');
  const itemFields = props.items
    .map((item) => renderItemGroup(prefix, item, getLectItems(lect, item.name), language, defaultLanguage))
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
  items: LectItem[],
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
                          ${renderLectFields(itemPrefix, item, nestedProps, language, defaultLanguage)}
                        </div>`;
              })
              .join('')
          : '<p class="text-sm text-gray-400">No items yet.</p>'
      }
    </div>`;
}

function renderInput(name: string, label: string, value: string, type: string, placeholder = ''): string {
  const isLong = type.includes('textarea') || label === 'body' || label === 'description';
  const input = isLong
    ? `<textarea name="${escHtml(name)}" rows="4"
                 placeholder="${escHtml(placeholder)}"
                 class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(value)}</textarea>`
    : `<input type="${type === 'date' ? 'date' : 'text'}" name="${escHtml(name)}"
              value="${escHtml(value)}"
              placeholder="${escHtml(placeholder)}"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">`;

  return `<label class="${isLong ? 'col-span-2' : ''} block">
            <span class="block text-sm font-medium text-gray-700 mb-1">${escHtml(label)}</span>
            ${input}
          </label>`;
}

function fieldLabel(name: string): string {
  return name.replace(/__/g, '.');
}

export async function editorPage(views: Fetcher, opts: {
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
    lect: Lect;
    blueprintProps: BlueprintProps;
    blockProps: Record<string, BlueprintProps>;
    blockNames: string[];
    versions: PageVersion[];
  };
}): Promise<string> {
  const {
    siteTitle,
    userName,
    userRole,
    userAvatar,
    page,
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
  const structuredBlock = structured ? await renderStructuredEditor(views, structured) : '';
  const versionHrefBase = page ? `/admin/pages/${page.id}/edit` : action;
  const versions = structured?.versions.map((version) => ({
    label: `${version.created_at}${version.action ? ` - ${version.action}` : ''}`,
    href: `${versionHrefBase}?version=${version.id}`,
    revertAction: `revert:${version.id}`,
  })) ?? [];

  const body = await renderView(views, '/templates/editor.json', {
    pageTitle,
    action,
    isEdit,
    saveLabel: isEdit ? 'Save Changes' : 'Create Page',
    errors,
    hasErrors: errors.length > 0,
    page: {
      name: page?.name ?? '',
      slug: page?.slug ?? '',
      pageType: page?.page_type ?? defaultPageType,
      weight: page?.weight ?? 5,
      start: page?.start ? page.start.replace(' ', 'T').slice(0, 16) : '',
      end: page?.end ? page.end.replace(' ', 'T').slice(0, 16) : '',
      lect: page?.lect ?? '',
    },
    parentOptions: parentPages
      .filter((parent) => parent.id !== page?.id)
      .map((parent) => ({
        id: parent.id,
        name: parent.name,
        selected: page?.page_id === parent.id,
      })),
    pageTypeOptions: structured
      ? Object.keys(structured.config.blueprint).map((pageType) => ({ value: pageType }))
      : [],
    structuredBlock,
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      checked: selectedTagIds.includes(tag.id),
    })),
    hasTags: tags.length > 0,
    versions,
    hasVersions: versions.length > 0,
  });

  return layout(views, {
    title: pageTitle,
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
