import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { PageType } from '../types';

export interface PageTypeListItem {
  name: string;
  slug: string;
  /** 'db' (editable), 'config' (read-only), or 'plugin' (read-only, from a plugin). */
  source: string;
  pluginName: string;
  editHref: string;
  viewHref: string;
  isDb: boolean;
}

export async function pageTypesPage(views: Fetcher, opts: BaseTemplateProps & {
  dbPageTypes: PageType[];
  configPageTypes: Array<{ slug: string; name: string; source?: string; pluginName?: string }>;
  canWrite: boolean;
}): Promise<string> {
  const { dbPageTypes, configPageTypes, canWrite } = opts;

  const items: PageTypeListItem[] = [
    ...dbPageTypes.map((pageType) => ({
      name: pageType.name,
      slug: pageType.slug,
      source: 'db',
      pluginName: '',
      editHref: `/admin/page_types/${pageType.id}/edit`,
      viewHref: '',
      isDb: true,
    })),
    ...configPageTypes.map((pageType) => ({
      name: pageType.name,
      slug: pageType.slug,
      source: pageType.source ?? 'config',
      pluginName: pageType.pluginName ?? '',
      editHref: '',
      viewHref: `/admin/page_types/view/${encodeURIComponent(pageType.slug)}`,
      isDb: false,
    })),
  ];

  const body = await renderView(views, '/templates/page-types.json', {
    hasPageTypes: items.length > 0,
    pageTypes: items,
    canWrite,
  });

  return adminLayout(views, opts, { title: 'Page Types', body });
}

export interface PageTypeFormModel {
  mode: 'new' | 'edit' | 'view';
  id?: number;
  error?: string;
  name: string;
  slug: string;
  weight: string;
  blueprint: string;
  selectedBlocks: string[];
  selectedTaxonomies: string[];
  /** All block-type slugs (config + database) available to choose from. */
  availableBlocks: string[];
  /** All taxonomies (database) available to choose from. */
  availableTaxonomies: Array<{ slug: string; name: string }>;
}

export async function pageTypeFormPage(views: Fetcher, opts: BaseTemplateProps & PageTypeFormModel): Promise<string> {
  const { mode, id, error } = opts;
  const readOnly = mode === 'view';
  const isEdit = mode === 'edit';
  const heading = mode === 'view' ? 'View Page Type' : mode === 'edit' ? 'Edit Page Type' : 'New Page Type';

  const selectedBlocks = new Set(opts.selectedBlocks);
  const selectedTaxonomies = new Set(opts.selectedTaxonomies);

  // Union available with selected so a stored value still shows even if its
  // definition is missing from the current config.
  const blockSlugs = [...new Set([...opts.availableBlocks, ...opts.selectedBlocks])];
  const taxonomyBySlug = new Map(opts.availableTaxonomies.map((taxonomy) => [taxonomy.slug, taxonomy.name]));
  const taxonomySlugs = [...new Set([...opts.availableTaxonomies.map((taxonomy) => taxonomy.slug), ...opts.selectedTaxonomies])];

  const blockOptions = blockSlugs.map((slug) => ({ value: slug, label: slug, checked: selectedBlocks.has(slug) }));
  const taxonomyOptions = taxonomySlugs.map((slug) => ({
    value: slug,
    label: taxonomyBySlug.get(slug) || slug,
    checked: selectedTaxonomies.has(slug),
  }));

  const body = await renderView(views, '/templates/page-type-form.json', {
    isEdit,
    readOnly,
    heading,
    action: isEdit ? `/admin/page_types/${id}` : '/admin/page_types',
    deleteAction: isEdit ? `/admin/page_types/${id}/delete` : '',
    error: error ?? '',
    hasError: !!error,
    name: opts.name,
    slug: opts.slug,
    blueprint: opts.blueprint,
    weight: opts.weight,
    blockOptions,
    hasBlockOptions: blockOptions.length > 0,
    taxonomyOptions,
    hasTaxonomyOptions: taxonomyOptions.length > 0,
  });

  return adminLayout(views, opts, { title: heading, body });
}
