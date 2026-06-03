import tagTypeFormTemplate from '../views/templates/tag-type-form.liquid';
import tagTypesTemplate from '../views/templates/tag-types.liquid';
import { layout } from './layout';
import { renderLiquid } from './liquid';
import type { TagType } from '../types';

export function tagTypesPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagTypes: TagType[];
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagTypes } = opts;
  const body = renderLiquid(tagTypesTemplate, {
    hasTagTypes: tagTypes.length > 0,
    tagTypes: tagTypes.map((tagType) => ({
      id: tagType.id,
      name: tagType.name,
      slug: tagType.slug,
      editHref: `/admin/tag-types/${tagType.id}/edit`,
    })),
  });

  return layout({
    title: 'Tag Types',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export function tagTypeFormPage(opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagType?: TagType;
}): string {
  const { siteTitle, userName, userRole, userAvatar, tagType } = opts;
  const body = renderLiquid(tagTypeFormTemplate, {
    isEdit: !!tagType,
    heading: tagType ? 'Edit Tag Type' : 'New Tag Type',
    action: tagType ? `/admin/tag-types/${tagType.id}` : '/admin/tag-types',
    name: tagType?.name ?? '',
    slug: tagType?.slug ?? '',
    deleteAction: tagType ? `/admin/tag-types/${tagType.id}/delete` : '',
  });

  return layout({
    title: tagType ? 'Edit Tag Type' : 'New Tag Type',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
