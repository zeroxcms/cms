// Shared templates for the page-type and block-type admin. The two entities
// are parallel tables with identical listing and near-identical forms, so one
// generic list/form model renders both; per-entity wording and the form view
// path come from the TypeAdminCopy the route spec provides.

import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { ConfigTypeRow } from '../utils/type-admin';

/** Per-entity wording and view wiring for the shared type templates. */
export interface TypeAdminCopy {
  /** '/admin/page_types' */
  routeBase: string;
  /** 'Page Types' */
  title: string;
  /** 'Page Type' */
  singular: string;
  /** Translation catalog namespace under `types`. */
  translationKey: 'page_types' | 'block_types';
  /** List-page subtitle. */
  description: string;
  /** Form JSON template, e.g. '/templates/page-type-form.json'. */
  formTemplate: string;
}

export async function typeListPage(views: Fetcher, opts: BaseTemplateProps & {
  copy: TypeAdminCopy;
  dbRows: Array<{ id: number; name: string; slug: string }>;
  configRows: ConfigTypeRow[];
  canWrite: boolean;
}): Promise<string> {
  const { copy, dbRows, configRows, canWrite } = opts;

  const items = [
    ...dbRows.map((row) => ({
      name: row.name,
      slug: row.slug,
      source: 'db',
      pluginName: '',
      editHref: `${copy.routeBase}/${row.id}/edit`,
      viewHref: '',
      isDb: true,
    })),
    ...configRows.map((row) => ({
      name: row.name,
      slug: row.slug,
      source: row.source,
      pluginName: row.pluginName,
      editHref: '',
      viewHref: `${copy.routeBase}/view/${encodeURIComponent(row.slug)}`,
      isDb: false,
    })),
  ];

  const body = await renderView(views, '/templates/type-list.json', {
    titleKey: `types.${copy.translationKey}.title`,
    descriptionKey: `types.${copy.translationKey}.description`,
    newHref: `${copy.routeBase}/new`,
    newLabelKey: `types.${copy.translationKey}.new`,
    hasTypes: items.length > 0,
    types: items,
    canWrite,
  });

  return adminLayout(views, opts, { title: copy.title, body });
}

export interface TypeFormModel {
  mode: 'new' | 'edit' | 'view';
  id?: number;
  error?: string;
  name: string;
  slug: string;
  weight: string;
  blueprint: string;
  /** Page types only — stored selections the decorate step turns into options. */
  selectedBlocks?: string[];
  selectedTaxonomies?: string[];
  /** View mode only — the user may add blocks/taxonomies to this read-only type. */
  canExtend?: boolean;
  /** View mode only — entries owned by the config/plugin, not un-checkable. */
  lockedBlocks?: string[];
  lockedTaxonomies?: string[];
}

export interface TypeFormOption {
  value: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
}

export async function typeFormPage(views: Fetcher, opts: BaseTemplateProps & TypeFormModel & {
  copy: TypeAdminCopy;
  blockOptions?: TypeFormOption[];
  taxonomyOptions?: TypeFormOption[];
}): Promise<string> {
  const { copy, mode, id, error } = opts;
  const readOnly = mode === 'view';
  const isEdit = mode === 'edit';
  const canExtend = readOnly && !!opts.canExtend;
  const heading = `${mode === 'view' ? 'View' : mode === 'edit' ? 'Edit' : 'New'} ${copy.singular}`;

  const body = await renderView(views, copy.formTemplate, {
    isEdit,
    readOnly,
    canExtend,
    canSave: !readOnly || canExtend,
    heading,
    headingKey: `types.${copy.translationKey}.${mode}_title`,
    action: canExtend
      ? `${copy.routeBase}/view/${encodeURIComponent(opts.slug)}`
      : isEdit ? `${copy.routeBase}/${id}` : copy.routeBase,
    deleteAction: isEdit ? `${copy.routeBase}/${id}/delete` : '',
    error: error ?? '',
    hasError: !!error,
    name: opts.name,
    slug: opts.slug,
    blueprint: opts.blueprint,
    weight: opts.weight,
    ...(opts.blockOptions
      ? { blockOptions: opts.blockOptions, hasBlockOptions: opts.blockOptions.length > 0 }
      : {}),
    ...(opts.taxonomyOptions
      ? { taxonomyOptions: opts.taxonomyOptions, hasTaxonomyOptions: opts.taxonomyOptions.length > 0 }
      : {}),
  });

  return adminLayout(views, opts, { title: heading, body });
}
