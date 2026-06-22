import { layout, navFlags } from './layout';
import { renderView } from './liquid';
import type { Taxonomy } from '../types';

export async function taxonomiesPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  taxonomies: Taxonomy[];
  canWrite: boolean;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, taxonomies, canWrite } = opts;
  const body = await renderView(views, '/templates/taxonomies.json', {
    hasTaxonomies: taxonomies.length > 0,
    canWrite,
    taxonomies: taxonomies.map((taxonomy) => ({
      id: taxonomy.id,
      name: taxonomy.name,
      slug: taxonomy.slug,
      editHref: `/admin/taxonomies/${taxonomy.id}/edit`,
    })),
  });

  return layout(views, {
    ...navFlags(opts),
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
  readOnly?: boolean;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, taxonomy, readOnly = false } = opts;
  const heading = readOnly ? 'View Taxonomy' : taxonomy ? 'Edit Taxonomy' : 'New Taxonomy';
  const body = await renderView(views, '/templates/taxonomy-form.json', {
    isEdit: !!taxonomy,
    readOnly,
    heading,
    action: taxonomy ? `/admin/taxonomies/${taxonomy.id}` : '/admin/taxonomies',
    name: taxonomy?.name ?? '',
    slug: taxonomy?.slug ?? '',
    deleteAction: taxonomy ? `/admin/taxonomies/${taxonomy.id}/delete` : '',
  });

  return layout(views, {
    ...navFlags(opts),
    title: heading,
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
