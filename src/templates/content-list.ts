import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface ContentListMediaItem {
  key: string;
  mediaHref: string;
  size: string;
  uploadedAt: string;
  linkedPages: Array<{
    name: string;
    slug: string;
    editHref: string;
  }>;
}

export async function contentListPage(views: Fetcher, opts: BaseTemplateProps & {
  bucketConfigured: boolean;
  media: ContentListMediaItem[];
  nextHref: string;
}): Promise<string> {
  const body = await renderView(views, '/templates/content-list.json', {
    bucketConfigured: opts.bucketConfigured,
    hasMedia: opts.media.length > 0,
    media: opts.media.map((item) => ({
      ...item,
      linkedPageCount: item.linkedPages.length,
      hasLinkedPages: item.linkedPages.length > 0,
    })),
    hasNextPage: !!opts.nextHref,
    nextHref: opts.nextHref,
    deleteAction: '/admin/settings/content/delete',
  });

  return adminLayout(views, opts, { title: 'Content List', body });
}
