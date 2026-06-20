import { layout } from './layout';
import { renderView } from './liquid';
import type { PageType } from '../types';

export interface PageTypeListItem {
  name: string;
  slug: string;
  /** 'db' (editable) or 'config' (read-only). */
  source: string;
  editHref: string;
  isDb: boolean;
}

export async function pageTypesPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  dbPageTypes: PageType[];
  configPageTypes: Array<{ slug: string; name: string }>;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, dbPageTypes, configPageTypes } = opts;

  const items: PageTypeListItem[] = [
    ...dbPageTypes.map((pageType) => ({
      name: pageType.name,
      slug: pageType.slug,
      source: 'db',
      editHref: `/admin/page_types/${pageType.id}/edit`,
      isDb: true,
    })),
    ...configPageTypes.map((pageType) => ({
      name: pageType.name,
      slug: pageType.slug,
      source: 'config',
      editHref: '',
      isDb: false,
    })),
  ];

  const body = await renderView(views, '/templates/page-types.json', {
    hasPageTypes: items.length > 0,
    pageTypes: items,
  });

  return layout(views, {
    title: 'Page Types',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export async function pageTypeFormPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  pageType?: PageType;
  error?: string;
  values?: { name: string; slug: string; blueprint: string; blocks: string; blockLists: string; tagLists: string; weight: string };
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, pageType, error, values } = opts;

  const body = await renderView(views, '/templates/page-type-form.json', {
    isEdit: !!pageType,
    heading: pageType ? 'Edit Page Type' : 'New Page Type',
    action: pageType ? `/admin/page_types/${pageType.id}` : '/admin/page_types',
    deleteAction: pageType ? `/admin/page_types/${pageType.id}/delete` : '',
    error: error ?? '',
    hasError: !!error,
    name: values?.name ?? pageType?.name ?? '',
    slug: values?.slug ?? pageType?.slug ?? '',
    blueprint: values?.blueprint ?? pageType?.blueprint ?? '[]',
    blocks: values?.blocks ?? pageType?.blocks ?? '',
    blockLists: values?.blockLists ?? pageType?.block_lists ?? '',
    tagLists: values?.tagLists ?? pageType?.tag_lists ?? '',
    weight: values?.weight ?? String(pageType?.weight ?? 5),
  });

  return layout(views, {
    title: pageType ? 'Edit Page Type' : 'New Page Type',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
