import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { Taxonomy } from '../types';

export async function taxonomiesPage(views: Fetcher, opts: BaseTemplateProps & {
  taxonomies: Taxonomy[];
  canWrite: boolean;
}): Promise<string> {
  const { taxonomies, canWrite } = opts;
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

  return adminLayout(views, opts, { title: 'Taxonomies', body });
}

export async function taxonomyFormPage(views: Fetcher, opts: BaseTemplateProps & {
  taxonomy?: Taxonomy;
  readOnly?: boolean;
}): Promise<string> {
  const { taxonomy, readOnly = false } = opts;
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

  return adminLayout(views, opts, { title: heading, body });
}
