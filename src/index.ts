// ============================================================
// Worker CMS – main entry point
//
// Routes:
//   /auth/*   – OAuth 2.1 login / callback / logout / refresh
//   /admin/*  – Protected CMS admin UI (editor roles required)
//   /         – Public site (reads from live content tables)
// ============================================================

import { Hono } from 'hono';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { errorPage } from './templates/errors';
import {
  canonicalHostResponse,
  rejectCrossOriginMutation,
  withSecurityHeaders,
} from './utils/security';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  const canonicalOrigin = c.env.CANONICAL_ORIGIN ?? 'https://cms.eventuai.com';
  const canonicalResponse = canonicalHostResponse(
    c.req.raw,
    canonicalOrigin,
  );
  if (canonicalResponse) return withSecurityHeaders(canonicalResponse);

  const crossOriginMutation = rejectCrossOriginMutation(c.req.raw, [canonicalOrigin]);
  if (crossOriginMutation) return withSecurityHeaders(crossOriginMutation);

  await next();
  c.res = withSecurityHeaders(c.res);
  return undefined;
});

// ── Auth (OAuth 2.1 + JWT) ────────────────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin UI (protected) ──────────────────────────────────────────────────────
app.route('/admin', adminRoutes);

// ── Media files from optional R2 binding ──────────────────────────────────────
app.get('/media/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media\//, '');
  const object = await c.env.MEDIA_BUCKET.get(key);
  if (!object) return c.notFound();

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('ETag', object.httpEtag);
  return new Response(object.body, { headers });
});

// ── Login shortcut ────────────────────────────────────────────────────────────
app.get('/login', (c) => c.redirect('/auth/login'));

// ── Favicon ───────────────────────────────────────────────────────────────────
app.get('/favicon.ico', () => new Response(null, { status: 204 }));

// ── Public root ───────────────────────────────────────────────────────────────
app.get('/', (c) => {
  // Redirect root to the login page if no other public site handler is installed
  return c.redirect('/auth/login');
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.notFound((c) => {
  return c.html(
    errorPage({
      status: 404,
      title: 'Not Found',
      heading: 'Page Not Found',
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    }),
    404,
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error(err);
  return c.html(
    errorPage({
      status: 500,
      title: 'Server Error',
      heading: 'Internal Server Error',
      message: 'Please try again later.',
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    }),
    500,
  );
});

export default app;
