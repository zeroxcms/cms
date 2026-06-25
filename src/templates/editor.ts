import { adminLayout, escHtml, type BaseTemplateProps } from './layout';
import { renderLiquid, renderView, templateExists } from './liquid';
import type { Page, PageVersion, Tag, Taxonomy } from '../types';
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

const implicitItemAttributes: FieldProps[] = [
  { name: '_weight', type: 'number' },
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
  const rootFields = await renderLectFields(views, '', lect, blueprintProps, language, config.defaultLanguage);
  const blocks = await Promise.all(getLectBlocks(lect)
    .map((block, index) => ({ block, index }))
    .sort(
      (left, right) =>
        blockWeight(left.block, left.index) - blockWeight(right.block, right.index) || left.index - right.index,
    )
    .map(async ({ block, index }) => {
      const type = String(block._type || 'default');
      const blockWithDefaults = withImplicitBlockAttributes(block, type, index);
      const blockFields = await renderLectFields(
        views,
        `#${index}`,
        blockWithDefaults,
        withImplicitBlockProps(blockProps[type] ?? blockProps.default),
        language,
        config.defaultLanguage,
        { omitWeight: true },
      );
      return {
        index,
        type,
        name: getLectScalar(blockWithDefaults, '_name') || type,
        id: blockWithDefaults._id ?? '',
        weight: blockWeight(blockWithDefaults, index),
        weightInputName: `#${index}@_weight`,
        weightInputId: fieldId(`#${index}@_weight`),
        deleteAction: `block-delete:${index}`,
        settingsHtml: blockFields.settingsHtml,
        contentHtml: blockFields.contentHtml,
        hasSettings: blockFields.hasSettings,
        hasContent: blockFields.hasContent,
      };
    }));

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
  return {
    ...props,
    attributes: withImplicitAttributes(props.attributes, implicitBlockAttributes),
  };
}

function withImplicitItemProps(props: BlueprintProps): BlueprintProps {
  return {
    ...props,
    attributes: withImplicitAttributes(props.attributes, implicitItemAttributes),
  };
}

function withImplicitAttributes(attributes: FieldProps[], implicitAttributes: FieldProps[]): FieldProps[] {
  const merged = [...implicitAttributes];
  for (const field of attributes) {
    if (!merged.some((implicitField) => implicitField.name === field.name)) merged.push(field);
  }
  return merged;
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

function withImplicitItemAttributes(item: LectItem, index: number): LectItem {
  return {
    ...item,
    _weight: item._weight ?? index,
  };
}

function itemWeight(item: LectItem, fallback: number): number {
  const weight = Number(item._weight ?? fallback);
  return Number.isFinite(weight) ? weight : fallback;
}

async function renderLectFields(
  views: Fetcher,
  prefix: string,
  lect: Lect | LectItem,
  props: BlueprintProps,
  language: string,
  defaultLanguage: string,
  options: { omitWeight?: boolean } = {},
): Promise<RenderedLectFields> {
  const attributeFields = (await Promise.all(props.attributes
    .filter((field) => !options.omitWeight || field.name !== '_weight')
    .map((field) => renderPageField(views, {
    prefix,
    field,
    kind: 'attribute',
    inputName: `${prefix}@${field.name}`,
    label: fieldLabel(field.name),
    value: getLectScalar(lect, field.name),
    language,
    defaultLanguage,
    lect,
  })))).join('');
  const pointerFields = (await Promise.all(props.pointers.map((field) => renderPageField(views, {
    prefix,
    field,
    kind: 'pointer',
    inputName: `${prefix}*${field.name}`,
    label: `${fieldLabel(field.name)} reference`,
    value: getLectPointer(lect, field.name),
    language,
    defaultLanguage,
    lect,
  })))).join('');
  const valueFields = (await Promise.all(props.fields.map((field) => renderPageField(views, {
    prefix,
    field,
    kind: 'value',
    inputName: `${prefix}.${field.name}|${language}`,
    label: fieldLabel(field.name),
    value: getLectLocalizedValue(lect, field.name, language),
    placeholder: language === defaultLanguage ? '' : getLectLocalizedValue(lect, field.name, defaultLanguage),
    language,
    defaultLanguage,
    lect,
  })))).join('');
  const itemFields = (await Promise.all(
    props.items.map((item) => renderItemGroup(views, prefix, item, getLectItems(lect, item.name), language, defaultLanguage)),
  )).join('');
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

async function renderItemGroup(
  views: Fetcher,
  prefix: string,
  props: NonNullable<BlueprintProps['items'][number]>,
  items: LectItem[],
  language: string,
  defaultLanguage: string,
): Promise<string> {
  const rows = items.length
    ? items
        .map((item, index) => ({ item, index }))
        .sort((left, right) => itemWeight(left.item, left.index) - itemWeight(right.item, right.index) || left.index - right.index)
    : [];
  const blockMatch = prefix.match(/^#(\d+)/);
  const addAction = blockMatch ? `block-item-add:${blockMatch[1]}|${props.name}` : `item-add:${props.name}`;
  const groupProps = withImplicitItemProps({
    attributes: props.attributes,
    pointers: props.pointers,
    fields: props.fields,
    items: props.items ?? [],
  });
  const rowHtml = rows.length
    ? (await Promise.all(rows.map(async ({ item, index }, displayIndex) => {
      const itemPrefix = `${prefix}.${props.name}[${index}]`;
      const deleteAction = blockMatch
        ? `block-item-delete:${blockMatch[1]}|${props.name}|${index}`
        : `item-delete:${props.name}|${index}`;
      const itemWithDefaults = withImplicitItemAttributes(item, index);
      const itemFields = await renderLectFields(
        views,
        itemPrefix,
        itemWithDefaults,
        groupProps,
        language,
        defaultLanguage,
        { omitWeight: true },
      );
      const weightInputName = `${itemPrefix}@_weight`;
      const deleteButton = rows.length > 1
        ? `<button type="submit" name="action" value="${escHtml(deleteAction)}"
                   title="Delete item ${displayIndex + 1}" aria-label="Delete item ${displayIndex + 1}"
                   class="inline-flex h-8 w-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-50 hover:text-red-700">
             <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><use href="/assets/icons.svg#trash-can"></use></svg>
             <span class="sr-only">Delete</span>
           </button>`
        : '';
      return `<div class="min-w-0 rounded-lg bg-white border border-gray-200 p-4 space-y-3">
                <div class="flex items-center justify-between gap-3">
                  <span class="min-w-0 text-xs text-gray-400">Item ${displayIndex + 1}</span>
                  <div class="flex shrink-0 items-center gap-3">
                    ${renderCompactWeightInput(weightInputName, itemWithDefaults._weight, `Weight for item ${displayIndex + 1}`)}
                    ${deleteButton}
                  </div>
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
    }))).join('')
    : '<p class="text-sm text-gray-400">No items yet.</p>';

  return `
    <div class="min-w-0 rounded-lg border border-gray-100 bg-gray-50 p-4 space-y-4">
      <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p class="min-w-0 break-words text-sm font-semibold text-gray-700">${escHtml(props.name)}</p>
        <button type="submit" name="action" value="${escHtml(addAction)}"
                class="w-full shrink-0 px-3 py-1.5 rounded-lg bg-white border border-gray-300 text-xs font-semibold text-gray-700 sm:w-auto">Add Item</button>
      </div>
      ${rowHtml}
    </div>`;
}

function renderCompactWeightInput(name: string, value: unknown, label: string): string {
  const id = fieldId(name);
  return `<div class="flex items-center gap-1 text-sm text-gray-500">
            <span aria-hidden="true">#</span>
            <label for="${escHtml(id)}" class="sr-only">${escHtml(label)}</label>
            <input type="number" id="${escHtml(id)}" name="${escHtml(name)}"
                   value="${escHtml(String(value ?? ''))}"
                   class="w-12 border-b border-transparent bg-transparent p-0 text-right text-lg font-bold focus:border-indigo-500 focus:outline-none">
          </div>`;
}

async function renderPageField(views: Fetcher, opts: {
  prefix: string;
  field: FieldProps;
  kind: 'attribute' | 'pointer' | 'value';
  inputName: string;
  label: string;
  value: string;
  language: string;
  defaultLanguage: string;
  lect: Lect | LectItem;
  placeholder?: string;
}): Promise<string> {
  const templatePath = opts.field.renderer ? pageFieldTemplatePath(opts.field.renderer) : null;
  if (!templatePath || !(await templateExists(views, templatePath))) {
    return renderInput(opts.inputName, opts.label, opts.value, opts.field.type, opts.placeholder);
  }

  return renderLiquid(views, templatePath, {
    field: {
      name: opts.field.name,
      type: opts.field.type,
      kind: opts.kind,
      prefix: opts.prefix,
      inputName: opts.inputName,
      id: fieldId(opts.inputName),
      label: opts.label,
      value: opts.value,
      placeholder: opts.placeholder ?? '',
      language: opts.language,
      defaultLanguage: opts.defaultLanguage,
    },
    values: pageFieldValues(opts.lect, opts.field.name, opts.language, opts.defaultLanguage),
    names: pageFieldNames(opts.prefix, opts.field.name, opts.kind, opts.language),
  });
}

function pageFieldTemplatePath(type: string): string | null {
  const trimmed = type.trim();
  if (!trimmed) return null;
  if (!trimmed.split('/').every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const typedPath = trimmed.includes('/') ? trimmed : `${trimmed}/basic`;
  return `/snippets/pagefield/${typedPath}.liquid`;
}

function pageFieldValues(lect: Lect | LectItem, name: string, language: string, defaultLanguage: string): Record<string, string> {
  return {
    value: getLectLocalizedValue(lect, name, language, defaultLanguage) || getLectScalar(lect, name),
    label: getLectLocalizedValue(lect, `${name}__label`, language, defaultLanguage),
    url: getLectLocalizedValue(lect, `${name}__url`, language, defaultLanguage),
    start: getLectLocalizedValue(lect, `${name}__start`, language, defaultLanguage),
    end: getLectLocalizedValue(lect, `${name}__end`, language, defaultLanguage),
    timezone: getLectLocalizedValue(lect, `${name}__timezone`, language, defaultLanguage),
  };
}

function pageFieldNames(prefix: string, name: string, kind: 'attribute' | 'pointer' | 'value', language: string): Record<string, string> {
  if (kind === 'attribute') return { value: `${prefix}@${name}` };
  if (kind === 'pointer') return { value: `${prefix}*${name}` };
  return {
    value: `${prefix}.${name}|${language}`,
    label: `${prefix}.${name}__label|${language}`,
    url: `${prefix}.${name}__url|${language}`,
    start: `${prefix}.${name}__start|${language}`,
    end: `${prefix}.${name}__end|${language}`,
    timezone: `${prefix}.${name}__timezone|${language}`,
  };
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

function editorChips(editors: string | null | undefined): string[] {
  return (editors ?? '')
    .split(',')
    .map((editor) => editor.trim())
    .filter(Boolean);
}

// ── Lect JSON version diff ──────────────────────────────────────────────────
// When previewing a saved version, the raw-metadata panel shows a colour-coded
// diff of that version's lect against the current draft instead of the editable
// textarea, so it's obvious what changed.

/** Recursively key-sorted, pretty-printed JSON so a line diff reflects value
 *  changes rather than key-ordering noise. Falls back to the raw input. */
function stablePrettyJson(json: string): string {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[key] = sortDeep((value as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return value;
  };
  try {
    return JSON.stringify(sortDeep(JSON.parse(json)), null, 2);
  } catch {
    return json;
  }
}

/**
 * Renders an escaped, colour-coded line diff (LCS) of the previewed version's
 * lect against the current draft's lect, as a run of block <span>s for a <pre>:
 * emerald = only in this version, rose = only in the current draft, grey = same.
 * Returns '' when there is no difference (or either side is missing).
 */
function renderLectDiff(draftJson: string, versionJson: string): string {
  const base = stablePrettyJson(draftJson).split('\n');     // current draft
  const target = stablePrettyJson(versionJson).split('\n'); // previewed version
  const n = base.length;
  const m = target.length;
  // Suffix LCS-length table, to walk a minimal diff.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = base[i] === target[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: string[] = [];
  let changed = false;
  const push = (cls: string, gutter: string, text: string) =>
    lines.push(`<span class="block ${cls}"><span class="select-none text-gray-400">${gutter}</span>${escHtml(text)}</span>`);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === target[j]) { push('text-gray-500', '  ', target[j]); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { push('bg-rose-50 text-rose-700', '- ', base[i]); i++; changed = true; }
    else { push('bg-emerald-50 text-emerald-800', '+ ', target[j]); j++; changed = true; }
  }
  while (i < n) { push('bg-rose-50 text-rose-700', '- ', base[i++]); changed = true; }
  while (j < m) { push('bg-emerald-50 text-emerald-800', '+ ', target[j++]); changed = true; }
  return changed ? lines.join('') : '';
}

export async function editorPage(views: Fetcher, opts: BaseTemplateProps & {
  page?: Page;
  modifierName?: string;
  version?: PageVersion;
  isVersionPreview?: boolean;
  liveVersionId?: number;
  parentPages: Page[];
  tags: Tag[];
  taxonomies: Taxonomy[];
  selectedTagIds: number[];
  errors?: string[];
  flash?: string;
  action: string;
  defaultPageType?: string;
  /** Timezone pre-filled into the start/end window when the page has none. */
  defaultTimezone?: string;
  /** Where the back arrow / Cancel button return to (e.g. a plugin dashboard). Defaults to /admin. */
  backHref?: string;
  /** Current draft's lect JSON — when previewing a version, the raw-metadata
   *  panel diffs the version against this instead of showing the editable box. */
  draftLect?: string;
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
    userAvatar,
    currentUserId,
    page,
    modifierName,
    version,
    isVersionPreview = false,
    liveVersionId,
    parentPages,
    tags,
    taxonomies,
    selectedTagIds,
    errors = [],
    flash,
    action,
    defaultPageType = '',
    defaultTimezone = '',
    backHref = '/admin',
    structured,
  } = opts;

  const isEdit = !!page;
  const selectedVersion = isVersionPreview && version ? version : undefined;
  const pageTitle = isEdit ? `Edit: ${page.name}` : 'New Page';
  const pageType = (structured ? getLectScalar(structured.lect, '_type') : '') || page?.page_type || defaultPageType || 'default';
  const structuredBlock = structured ? await renderStructuredEditor(views, structured) : '';
  const versionHrefBase = page ? `/admin/pages/${page.id}/edit` : action;
  const pageEditorChips = editorChips(page?.editors);
  const parentOptions = parentPages
    .filter((parent) => parent.id !== page?.id)
    .map((parent) => ({
      id: parent.id,
      name: parent.name,
      slug: parent.slug,
      label: `/${parent.slug}`,
      selected: page?.page_id === parent.id || parentPages.length === 1,
    }));
  const selectedParent = parentOptions.find((parent) => parent.selected);
  // When previewing a version, diff its lect against the current draft.
  const lectDiffHtml = selectedVersion && opts.draftLect != null
    ? renderLectDiff(opts.draftLect, page?.lect ?? '')
    : '';
  const versions = structured?.versions.map((version) => ({
    label: `${version.created_at}${version.action ? ` - ${version.action}` : ''}`,
    href: `${versionHrefBase}?version=${version.id}`,
    active: selectedVersion?.id === version.id,
    live: version.id === liveVersionId,
  })) ?? [];

  const body = await renderView(views, '/templates/editor.json', {
    pageTitle,
    action,
    backHref,
    deleteAction: page ? `/admin/pages/${page.id}/delete` : '',
    isEdit,
    isVersionPreview: !!selectedVersion,
    selectedVersion: selectedVersion
      ? {
          date: selectedVersion.created_at,
          restoreAction: `revert:${selectedVersion.id}`,
          currentHref: page ? `/admin/pages/${page.id}/edit` : action,
        }
      : undefined,
    saveLabel: isEdit ? 'Save Changes' : 'Create Page',
    errors,
    hasErrors: errors.length > 0,
    flash,
    hasFlash: !!flash,
    page: {
      id: page?.id ?? '',
      name: page?.name ?? '',
      slug: page?.slug ?? '',
      pageType: page?.page_type ?? defaultPageType,
      weight: page?.weight ?? 5,
      start: page?.start ? page.start.replace(' ', 'T').slice(0, 16) : '',
      end: page?.end ? page.end.replace(' ', 'T').slice(0, 16) : '',
      timezone: page?.timezone ?? defaultTimezone,
      creator: page?.creator ?? '',
      editors: page?.editors ?? '',
      editorChips: pageEditorChips,
      hasEditorChips: pageEditorChips.length > 0,
      modifierName: modifierName ?? '',
      hasModifier: !!modifierName,
      lect: page?.lect ?? '',
    },
    lectDiffHtml,
    hasLectDiff: !!lectDiffHtml,
    parentOptions,
    selectedParent: {
      id: selectedParent?.id ?? '',
      label: selectedParent?.label ?? '/',
    },
    pageTypeOptions: structured
      ? Object.keys(structured.config.blueprint).map((pageType) => ({ value: pageType }))
      : [],
    structuredBlock,
    ...editorTagGroups(
      tags,
      taxonomies,
      selectedTagIds,
      // Show only the taxonomies checked for this page type; when the page type
      // has none checked, fall back to showing every taxonomy.
      structured?.config.taxonomyLists[pageType] ?? taxonomies.map((taxonomy) => taxonomy.slug),
    ),
    versions,
    hasVersions: versions.length > 0,
    currentUserId,
    userAvatar,
  });

  return adminLayout(views, opts, { title: pageTitle, body });
}

function editorTagGroups(
  tags: Tag[],
  taxonomies: Taxonomy[],
  selectedTagIds: number[],
  taxonomySlugs: string[],
) {
  const selected = new Set(selectedTagIds);
  const taxonomiesBySlug = new Map(taxonomies.map((taxonomy) => [taxonomy.slug, taxonomy]));
  const renderedTagIds = new Set<number>();
  const tagGroups = taxonomySlugs
    .map((slug) => {
      const taxonomy = taxonomiesBySlug.get(slug);
      if (!taxonomy) return null;
      const groupTags = tags
        .filter((tag) => tag.taxonomy_id === taxonomy.id)
        .map((tag) => {
          renderedTagIds.add(tag.id);
          return {
            id: tag.id,
            name: tag.name,
            checked: selected.has(tag.id),
          };
        });
      return {
        name: taxonomy.name,
        slug: taxonomy.slug,
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
