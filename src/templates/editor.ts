import { layout, escHtml } from './layout';
import { renderLiquid, renderView } from './liquid';
import type { Page, PageVersion, Tag, TagType } from '../types';
import {
  getLectBlocks,
  getLectItems,
  getLectLocalizedValue,
  getLectPointer,
  getLectScalar,
} from '../utils/lect';
import type { BlueprintProps, FieldProps, Lect, LectItem } from '../utils/lect';
import type { CmsConfig } from '../cms-config';

interface RenderedLectFields {
  settingsHtml: string;
  contentHtml: string;
  hasSettings: boolean;
  hasContent: boolean;
}

const implicitBlockAttributes: FieldProps[] = [
  { name: '_weight', type: 'number' },
  { name: '_name', type: 'text' },
];

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
  const rootFields = renderLectFields('', lect, blueprintProps, language, config.defaultLanguage);
  const blocks = getLectBlocks(lect)
    .map((block, index) => ({ block, index }))
    .sort(
      (left, right) =>
        blockWeight(left.block, left.index) - blockWeight(right.block, right.index) || left.index - right.index,
    )
    .map(({ block, index }) => {
      const type = String(block._type || 'default');
      const blockWithDefaults = withImplicitBlockAttributes(block, type, index);
      const blockFields = renderLectFields(
        `#${index}`,
        blockWithDefaults,
        withImplicitBlockProps(blockProps[type] ?? blockProps.default),
        language,
        config.defaultLanguage,
      );
      return {
        index,
        type,
        name: getLectScalar(blockWithDefaults, '_name') || type,
        id: blockWithDefaults._id ?? '',
        weight: blockWeight(blockWithDefaults, index),
        deleteAction: `block-delete:${index}`,
        settingsHtml: blockFields.settingsHtml,
        contentHtml: blockFields.contentHtml,
        hasSettings: blockFields.hasSettings,
        hasContent: blockFields.hasContent,
      };
    });

  return renderLiquid(views, '/snippets/structured-editor.liquid', {
    languageOptions: config.languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    settingsHtml: rootFields.settingsHtml,
    contentHtml: rootFields.contentHtml,
    hasSettings: rootFields.hasSettings,
    hasContent: rootFields.hasContent,
    hasLanguageContent: rootFields.hasContent || blocks.some((block) => block.hasContent),
    blockOptions: blockNames.map((name) => ({ value: name })),
    hasBlockOptions: blockNames.length > 0,
    hasBlocks: blocks.length > 0,
    blocks,
  });
}

function withImplicitBlockProps(props: BlueprintProps): BlueprintProps {
  const attributes = [...implicitBlockAttributes];
  for (const field of props.attributes) {
    if (!attributes.some((implicitField) => implicitField.name === field.name)) attributes.push(field);
  }
  return {
    ...props,
    attributes,
  };
}

function withImplicitBlockAttributes(block: Lect, type: string, index: number): Lect {
  return {
    ...block,
    _type: type,
    _name: block._name ?? '',
    _weight: block._weight ?? index,
  };
}

function blockWeight(block: Lect, fallback: number): number {
  const weight = Number(block._weight ?? fallback);
  return Number.isFinite(weight) ? weight : fallback;
}

function renderLectFields(
  prefix: string,
  lect: Lect | LectItem,
  props: BlueprintProps,
  language: string,
  defaultLanguage: string,
): RenderedLectFields {
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
  const settingsHtml = renderFieldGrid(`${attributeFields}${pointerFields}`);
  const contentHtml = `${renderFieldGrid(valueFields)}${itemFields}`;

  return {
    settingsHtml,
    contentHtml,
    hasSettings: settingsHtml.length > 0,
    hasContent: contentHtml.length > 0,
  };
}

function renderFieldGrid(fieldsHtml: string): string {
  if (!fieldsHtml.trim()) return '';
  return `
    <div class="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5">
      ${fieldsHtml}
    </div>`;
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
    <div class="min-w-0 rounded-lg border border-gray-100 bg-gray-50 p-4 space-y-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="min-w-0 break-words text-sm font-semibold text-gray-700">${escHtml(props.name)}</p>
        <button type="submit" name="action" value="${escHtml(addAction)}"
                class="w-full shrink-0 px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-xs font-semibold text-gray-700 sm:w-auto">Add Item</button>
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
                const itemFields = renderLectFields(itemPrefix, item, nestedProps, language, defaultLanguage);
                return `<div class="min-w-0 rounded-lg bg-white border border-gray-200 p-4 space-y-3">
                          <div class="flex items-center justify-between gap-3">
                            <span class="min-w-0 text-xs text-gray-400">Item ${index + 1}</span>
                            <button type="submit" name="action" value="${escHtml(deleteAction)}"
                                    class="shrink-0 text-xs font-semibold text-red-600 hover:text-red-700">Delete</button>
                          </div>
                          ${
                            itemFields.hasSettings
                              ? `<div class="space-y-3">
                                   <p class="text-xs font-semibold uppercase tracking-wide text-gray-400">Settings</p>
                                   ${itemFields.settingsHtml}
                                 </div>`
                              : ''
                          }
                          ${itemFields.contentHtml}
                        </div>`;
              })
              .join('')
          : '<p class="text-sm text-gray-400">No items yet.</p>'
      }
    </div>`;
}

function renderInput(name: string, label: string, value: string, type: string, placeholder = ''): string {
  const isLong = type.includes('textarea') || label === 'body' || label === 'description';
  const inputType = type === 'date' || type === 'number' ? type : 'text';
  const id = fieldId(name);
  const input = isLong
    ? `<textarea id="${escHtml(id)}" name="${escHtml(name)}" rows="4"
                 placeholder="${escHtml(placeholder)}"
                 class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y">${escHtml(value)}</textarea>`
    : `<input id="${escHtml(id)}" type="${inputType}" name="${escHtml(name)}"
              value="${escHtml(value)}"
              placeholder="${escHtml(placeholder)}"
              class="block min-w-0 w-full max-w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent">`;

  return `<label for="${escHtml(id)}" class="${isLong ? 'sm:col-span-2' : ''} min-w-0 block">
            <span class="block text-sm font-medium text-gray-700 mb-1">${escHtml(label)}</span>
            ${input}
          </label>`;
}

function fieldId(name: string): string {
  return `field_${Array.from(name)
    .map((char) => (/^[A-Za-z0-9_-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16)}_`))
    .join('')}`;
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
  tagTypes: TagType[];
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
    tagTypes,
    selectedTagIds,
    errors = [],
    action,
    defaultPageType = '',
    structured,
  } = opts;

  const isEdit = !!page;
  const pageTitle = isEdit ? `Edit: ${page.name}` : 'New Page';
  const pageType = (structured ? getLectScalar(structured.lect, '_type') : '') || page?.page_type || defaultPageType || 'default';
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
    ...editorTagGroups(
      tags,
      tagTypes,
      selectedTagIds,
      structured?.config.tagLists[pageType] ?? structured?.config.tagLists.default ?? [],
    ),
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

function editorTagGroups(
  tags: Tag[],
  tagTypes: TagType[],
  selectedTagIds: number[],
  tagTypeSlugs: string[],
) {
  const selected = new Set(selectedTagIds);
  const tagTypesBySlug = new Map(tagTypes.map((tagType) => [tagType.slug, tagType]));
  const renderedTagIds = new Set<number>();
  const tagGroups = tagTypeSlugs
    .map((slug) => {
      const tagType = tagTypesBySlug.get(slug);
      if (!tagType) return null;
      const groupTags = tags
        .filter((tag) => tag.tag_type_id === tagType.id)
        .map((tag) => {
          renderedTagIds.add(tag.id);
          return {
            id: tag.id,
            name: tag.name,
            checked: selected.has(tag.id),
          };
        });
      return {
        name: tagType.name,
        slug: tagType.slug,
        tags: groupTags,
        hasTags: groupTags.length > 0,
      };
    })
    .filter((group): group is NonNullable<typeof group> => !!group);
  const preservedTagIds = selectedTagIds.filter((id) => !renderedTagIds.has(id));

  return {
    tagGroups,
    hasTagGroups: tagGroups.length > 0,
    preservedTagIds,
    hasPreservedTagIds: preservedTagIds.length > 0,
  };
}
