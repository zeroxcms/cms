import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { Tag, Taxonomy } from '../types';

export interface TagTaxonomyOption {
  id: string;
  name: string;
  disabled?: boolean;
  sourceLabel?: string;
}

export async function tagsPage(views: Fetcher, opts: BaseTemplateProps & {
  taxonomies: Taxonomy[];
  tags: Tag[];
  filterTaxonomy: number;
}): Promise<string> {
  const { taxonomies, tags, filterTaxonomy } = opts;
  const taxonomyMap = new Map(taxonomies.map((type) => [type.id, type.name]));
  const body = await renderView(views, '/templates/tags.json', {
    hasTags: tags.length > 0,
    filterOptions: taxonomies.map((type) => ({
      id: type.id,
      name: type.name,
      selected: filterTaxonomy === type.id,
    })),
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      weight: tag.weight ?? 5,
      taxonomyName: tag.taxonomy_id ? taxonomyMap.get(tag.taxonomy_id) ?? '' : '',
      editHref: `/admin/tags/${tag.id}/edit`,
    })),
  });

  return adminLayout(views, opts, { title: 'Tags', body });
}

export async function tagFormPage(views: Fetcher, opts: BaseTemplateProps & {
  tag?: Tag;
  language: string;
  languages: string[];
  translatedName: string;
  translatedPlaceholder: string;
  taxonomies: TagTaxonomyOption[];
  parentTags: Tag[];
}): Promise<string> {
  const {
    tag,
    language,
    languages,
    translatedName,
    translatedPlaceholder,
    taxonomies,
    parentTags,
  } = opts;
  const body = await renderView(views, '/templates/tag-form.json', {
    isEdit: !!tag,
    heading: tag ? 'Edit Tag' : 'New Tag',
    action: tag ? `/admin/tags/${tag.id}` : '/admin/tags',
    name: tag?.name ?? '',
    slug: tag?.slug ?? '',
    weight: tag?.weight ?? 5,
    language,
    translatedFieldName: `.name|${language}`,
    translatedName,
    translatedPlaceholder,
    languageOptions: languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    taxonomyOptions: taxonomies.map((type) => ({
      id: type.id,
      name: type.sourceLabel ? `${type.name} (${type.sourceLabel})` : type.name,
      selected: tag?.taxonomy_id != null && String(tag.taxonomy_id) === type.id,
      disabled: type.disabled ?? false,
    })),
    parentOptions: parentTags
      .filter((candidate) => candidate.id !== tag?.id)
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        selected: tag?.parent_tag === candidate.id,
      })),
    deleteAction: tag ? `/admin/tags/${tag.id}/delete` : '',
  });

  return adminLayout(views, opts, { title: tag ? 'Edit Tag' : 'New Tag', body });
}
