import { renderView } from './liquid';

export async function errorPage(views: Fetcher, opts: {
  status: 404 | 500;
  title: string;
  heading: string;
  message?: string;
  siteTitle: string;
}): Promise<string> {
  return renderView(views, '/templates/error.json', {
    ...opts,
    hasMessage: !!opts.message,
    sectionComments: false,
  });
}
