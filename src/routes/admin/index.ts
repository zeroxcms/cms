// ============================================================
// Admin routes (all protected by authMiddleware + editorGuard)
//
// Composed from feature sub-routers, all mounted under /admin:
//   search  – /advanced-search* (CSV import/export moved to the import-export plugin)
//   pages   – dashboard, /pages/* CRUD, list, publish, trash-on-delete
//   trash   – /trash* (list, restore, permanent delete)
//   tags    – /tags* and /taxonomies*
//   api     – /api/* JSON endpoints and /upload
//
// NOTE on ordering: Hono matches in registration order, so `search` is
// mounted before `pages` to ensure its static `/advanced-search...` routes
// win over the `/pages/:id` catch-all.
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, editorGuard } from '../../middleware/auth';
import type { Env, Variables } from '../../types';
import { searchRoutes } from './search';
import { pagesRoutes } from './pages';
import { trashRoutes } from './trash';
import { tagsRoutes } from './tags';
import { blockTypesRoutes, pageTypesRoutes } from './db-types';
import { usersRoutes } from './users';
import { rolesRoutes } from './roles';
import { profileRoutes } from './profile';
import { apiRoutes } from './api';
import { pluginAdminRoutes } from './plugins';
import { pluginsManageRoutes } from './plugins-manage';
import { settingsRoutes } from './settings';
import { viewsFor } from '../../plugins/views';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

adminRoutes.get('/views/*', async (c) => {
  const path = c.req.path.slice('/admin/views'.length);
  if (!path.startsWith('/') || path.includes('..')) return c.notFound();

  const response = await viewsFor(c.env).fetch(`https://views.local${path}`);
  if (!response.ok) return c.notFound();

  const headers = new Headers(response.headers);
  if (path.endsWith('.json')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  } else if (path.endsWith('.liquid')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  headers.set('Cache-Control', 'private, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
});

// Mount feature sub-routers. Order matters — see the note above.
adminRoutes.route('/', searchRoutes);
adminRoutes.route('/', pluginAdminRoutes);
adminRoutes.route('/', profileRoutes);
adminRoutes.route('/', pagesRoutes);
adminRoutes.route('/', trashRoutes);
adminRoutes.route('/', tagsRoutes);
adminRoutes.route('/', pageTypesRoutes);
adminRoutes.route('/', blockTypesRoutes);
adminRoutes.route('/', usersRoutes);
adminRoutes.route('/', rolesRoutes);
adminRoutes.route('/', pluginsManageRoutes);
adminRoutes.route('/', settingsRoutes);
adminRoutes.route('/', apiRoutes);
