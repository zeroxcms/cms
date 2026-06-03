import { renderLiquid } from './liquid';

export async function errorPage(views: Fetcher, opts: {
  status: 404 | 500;
  title: string;
  heading: string;
  message?: string;
  siteTitle: string;
}): Promise<string> {
  return renderLiquid(views, '/templates/error.liquid', {
    ...opts,
    hasMessage: !!opts.message,
  });
}
