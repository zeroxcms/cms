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
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>404 – Not Found</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen flex items-center justify-center bg-gray-50">
  <div class="text-center">
    <p class="text-6xl font-bold text-gray-300">404</p>
    <h1 class="mt-4 text-2xl font-semibold text-gray-700">Page Not Found</h1>
    <a href="/admin" class="mt-6 inline-block text-indigo-600 hover:underline">Back to Dashboard</a>
  </div>
</body>
</html>`,
    404,
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError((err, c) => {
  console.error(err);
  return c.html(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>500 – Server Error</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen flex items-center justify-center bg-gray-50">
  <div class="text-center">
    <p class="text-6xl font-bold text-gray-300">500</p>
    <h1 class="mt-4 text-2xl font-semibold text-gray-700">Internal Server Error</h1>
    <p class="mt-2 text-gray-500">Please try again later.</p>
    <a href="/admin" class="mt-6 inline-block text-indigo-600 hover:underline">Back to Dashboard</a>
  </div>
</body>
</html>`,
    500,
  );
});

export default app;
