import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { BlockType } from '../types';

export interface BlockTypeListItem {
  name: string;
  slug: string;
  /** 'db' (editable) or 'config' (read-only). */
  source: string;
  editHref: string;
  viewHref: string;
  isDb: boolean;
}

export async function blockTypesPage(views: Fetcher, opts: BaseTemplateProps & {
  dbBlockTypes: BlockType[];
  configBlockTypes: Array<{ slug: string; name: string }>;
  canWrite: boolean;
}): Promise<string> {
  const { dbBlockTypes, configBlockTypes, canWrite } = opts;

  const items: BlockTypeListItem[] = [
    ...dbBlockTypes.map((blockType) => ({
      name: blockType.name,
      slug: blockType.slug,
      source: 'db',
      editHref: `/admin/block_types/${blockType.id}/edit`,
      viewHref: '',
      isDb: true,
    })),
    ...configBlockTypes.map((blockType) => ({
      name: blockType.name,
      slug: blockType.slug,
      source: 'config',
      editHref: '',
      viewHref: `/admin/block_types/view/${encodeURIComponent(blockType.slug)}`,
      isDb: false,
    })),
  ];

  const body = await renderView(views, '/templates/block-types.json', {
    hasBlockTypes: items.length > 0,
    blockTypes: items,
    canWrite,
  });

  return adminLayout(views, opts, { title: 'Block Types', body });
}

export interface BlockTypeFormModel {
  mode: 'new' | 'edit' | 'view';
  id?: number;
  error?: string;
  name: string;
  slug: string;
  weight: string;
  blueprint: string;
}

export async function blockTypeFormPage(views: Fetcher, opts: BaseTemplateProps & BlockTypeFormModel): Promise<string> {
  const { mode, id, error } = opts;
  const readOnly = mode === 'view';
  const isEdit = mode === 'edit';
  const heading = mode === 'view' ? 'View Block Type' : mode === 'edit' ? 'Edit Block Type' : 'New Block Type';

  const body = await renderView(views, '/templates/block-type-form.json', {
    isEdit,
    readOnly,
    heading,
    action: isEdit ? `/admin/block_types/${id}` : '/admin/block_types',
    deleteAction: isEdit ? `/admin/block_types/${id}/delete` : '',
    error: error ?? '',
    hasError: !!error,
    name: opts.name,
    slug: opts.slug,
    blueprint: opts.blueprint,
    weight: opts.weight,
  });

  return adminLayout(views, opts, { title: heading, body });
}
