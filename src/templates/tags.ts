import tagFormTemplate from '../views/templates/tag-form.liquid';
import tagsTemplate from '../views/templates/tags.liquid';
import { layout } from './layout';
import { renderLiquid } from './liquid';
import type { Tag, TagType } from '../types';

export function tagsPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagTypes: TagType[];
  tags: Tag[];
  filterTagType: number;
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagTypes, tags, filterTagType } = opts;
  const tagTypeMap = new Map(tagTypes.map((type) => [type.id, type.name]));
  const body = renderLiquid(tagsTemplate, {
    hasTags: tags.length > 0,
    filterOptions: tagTypes.map((type) => ({
      id: type.id,
      name: type.name,
      selected: filterTagType === type.id,
    })),
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      slug: tag.slug,
      tagTypeName: tag.tag_type_id ? tagTypeMap.get(tag.tag_type_id) ?? '' : '',
      editHref: `/admin/tags/${tag.id}/edit`,
    })),
  });

  return layout({
    title: 'Tags',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export function tagFormPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tag?: Tag;
  language: string;
  languages: string[];
  translatedName: string;
  translatedPlaceholder: string;
  tagTypes: TagType[];
  parentTags: Tag[];
}): string {
  const {
    siteTitle,
    userName,
    userRole,
    userAvatar,
    tag,
    language,
    languages,
    translatedName,
    translatedPlaceholder,
    tagTypes,
    parentTags,
  } = opts;
  const body = renderLiquid(tagFormTemplate, {
    isEdit: !!tag,
    heading: tag ? 'Edit Tag' : 'New Tag',
    action: tag ? `/admin/tags/${tag.id}` : '/admin/tags',
    name: tag?.name ?? '',
    slug: tag?.slug ?? '',
    language,
    translatedFieldName: `.name|${language}`,
    translatedName,
    translatedPlaceholder,
    languageOptions: languages.map((lang) => ({
      value: lang,
      selected: lang === language,
    })),
    tagTypeOptions: tagTypes.map((type) => ({
      id: type.id,
      name: type.name,
      selected: tag?.tag_type_id === type.id,
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

  return layout({
    title: tag ? 'Edit Tag' : 'New Tag',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
