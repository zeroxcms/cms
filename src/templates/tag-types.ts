import { layout } from './layout';
import { renderView } from './liquid';
import type { TagType } from '../types';

export async function tagTypesPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagTypes: TagType[];
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, tagTypes } = opts;
  const body = await renderView(views, '/templates/tag-types.json', {
    hasTagTypes: tagTypes.length > 0,
    tagTypes: tagTypes.map((tagType) => ({
      id: tagType.id,
      name: tagType.name,
      slug: tagType.slug,
      editHref: `/admin/tag-types/${tagType.id}/edit`,
    })),
  });

  return layout(views, {
    title: 'Tag Types',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}

export async function tagTypeFormPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  tagType?: TagType;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, tagType } = opts;
  const body = await renderView(views, '/templates/tag-type-form.json', {
    isEdit: !!tagType,
    heading: tagType ? 'Edit Tag Type' : 'New Tag Type',
    action: tagType ? `/admin/tag-types/${tagType.id}` : '/admin/tag-types',
    name: tagType?.name ?? '',
    slug: tagType?.slug ?? '',
    deleteAction: tagType ? `/admin/tag-types/${tagType.id}/delete` : '',
  });

  return layout(views, {
    title: tagType ? 'Edit Tag Type' : 'New Tag Type',
    siteTitle,
    body,
    admin: true,
    userName,
    userRole,
    userAvatar,
  });
}
