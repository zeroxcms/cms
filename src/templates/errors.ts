import errorTemplate from '../views/templates/error.liquid';
import { renderLiquid } from './liquid';

export function errorPage(opts: {
  status: 404 | 500;
  title: string;
  heading: string;
  message?: string;
  siteTitle: string;
}): string {
  return renderLiquid(errorTemplate, {
    ...opts,
    hasMessage: !!opts.message,
  });
}
