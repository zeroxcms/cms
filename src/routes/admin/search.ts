// Advanced search pages and CSV exports.

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { exportAdvancedSearch, renderAdvancedSearch } from '../../utils/admin-render';

export const searchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

searchRoutes.get('/advanced-search', (c) => renderAdvancedSearch(c));

searchRoutes.get('/advanced-search-export', (c) => exportAdvancedSearch(c));

searchRoutes.get('/advanced-search-export/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return exportAdvancedSearch(c, pageType, false);
});

searchRoutes.get('/advanced-search/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return renderAdvancedSearch(c, pageType, false);
});
