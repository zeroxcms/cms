import { layout } from './layout';
import { renderView } from './liquid';
import type { Taxonomy } from '../types';

export async function taxonomiesPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  taxonomies: Taxonomy[];
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, taxonomies } = opts;
  const body = await renderView(views, '/templates/taxonomies.json', {
    hasTaxonomies: taxonomies.length > 0,
    taxonomies: taxonomies.map((taxonomy) => ({
      id: taxonomy.id,
      name: taxonomy.name,
      slug: taxonomy.slug,
      editHref: `/admin/taxonomies/${taxonomy.id}/edit`,
    })),
  });

  return layout(views, {
    title: 'Taxonomies',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export async function taxonomyFormPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  taxonomy?: Taxonomy;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, taxonomy } = opts;
  const body = await renderView(views, '/templates/taxonomy-form.json', {
    isEdit: !!taxonomy,
    heading: taxonomy ? 'Edit Taxonomy' : 'New Taxonomy',
    action: taxonomy ? `/admin/taxonomies/${taxonomy.id}` : '/admin/taxonomies',
    name: taxonomy?.name ?? '',
    slug: taxonomy?.slug ?? '',
    deleteAction: taxonomy ? `/admin/taxonomies/${taxonomy.id}/delete` : '',
  });

  return layout(views, {
    title: taxonomy ? 'Edit Taxonomy' : 'New Taxonomy',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
