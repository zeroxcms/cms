// ============================================================
// Admin routes (all protected by authMiddleware + editorGuard)
//
// Composed from feature sub-routers, all mounted under /admin:
//   search  – /advanced-search* (+ CSV export)
//   import  – /pages/import + /pages/import-v2 (+ /confirm)
//   pages   – dashboard, /pages/* CRUD, list, export, publish, trash-on-delete
//   trash   – /trash* (list, restore, permanent delete)
//   tags    – /tags* and /tag-types*
//   api     – /api/* JSON endpoints and /upload
//
// NOTE on ordering: Hono matches in registration order, so `search` and
// `import` are mounted before `pages` to ensure their static `/pages/...`
// and `/advanced-search...` routes win over the `/pages/:id` catch-all.
// ============================================================

import { Hono } from 'hono';
import { authMiddleware, editorGuard } from '../../middleware/auth';
import type { Env, Variables } from '../../types';
import { searchRoutes } from './search';
import { importRoutes } from './import';
import { pagesRoutes } from './pages';
import { trashRoutes } from './trash';
import { tagsRoutes } from './tags';
import { apiRoutes } from './api';
import { pluginAdminRoutes } from './plugins';

export const adminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Apply auth to all admin routes
adminRoutes.use('*', authMiddleware);
adminRoutes.use('*', editorGuard);

// Mount feature sub-routers. Order matters — see the note above.
adminRoutes.route('/', searchRoutes);
adminRoutes.route('/', importRoutes);
adminRoutes.route('/', pluginAdminRoutes);
adminRoutes.route('/', pagesRoutes);
adminRoutes.route('/', trashRoutes);
adminRoutes.route('/', tagsRoutes);
adminRoutes.route('/', apiRoutes);
