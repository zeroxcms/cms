// ============================================================
// 0xCMS - main entry point
//
// Routes:
//   /auth/*   – OAuth 2.1 login / callback / logout / refresh
//   /admin/*  – Protected CMS admin UI (editor roles required)
//   /         – Public site (reads from live content tables)
// ============================================================

import { Hono } from 'hono';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { cmsApiRoutes } from './routes/cms-api';
import { mediaRoutes } from './routes/media';
import { errorPage } from './templates/errors';
import {
  canonicalHostResponse,
  rejectCrossOriginMutation,
  withSensitiveCacheHeaders,
  withSecurityHeaders,
} from './security/http';
import { generateCspNonce, requestContext } from './utils/request-context';
import type { Env, Variables } from './types';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const MIN_JWT_SECRET_LENGTH = 32;
let warnedWeakJwtSecret = false;

app.use('*', async (c, next) => {
  // A weak HMAC secret lets anyone forge admin tokens, so refuse to serve
  // (outside local development) rather than run with a forgeable secret.
  if (!c.env.JWT_SECRET || c.env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    if (!warnedWeakJwtSecret) {
      warnedWeakJwtSecret = true;
      console.error(`JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LENGTH} characters`);
    }
    if (!isLocalHost(new URL(c.req.url).hostname)) {
      return withSensitiveCacheHeaders(
        withSecurityHeaders(new Response('Server misconfigured', { status: 500 })),
        c.req.raw,
      );
    }
  }

  const canonicalOrigin = c.env.CANONICAL_ORIGIN ?? 'https://cms.eventuai.com';
  const canonicalResponse = canonicalHostResponse(
    c.req.raw,
    canonicalOrigin,
  );
  if (canonicalResponse) {
    return withSensitiveCacheHeaders(withSecurityHeaders(canonicalResponse), c.req.raw);
  }

  // The /__cms plugin write-back API is a server-to-server channel authenticated
  // by PLUGIN_SECRET, not a browser. Such callers send no Origin/Referer, which
  // the fail-closed cross-origin guard would reject — so skip the guard here.
  // (The secret, not browser provenance, is the authenticator for /__cms.)
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/__cms/') && !(path === '/auth/callback' && c.req.method === 'POST')) {
    const crossOriginMutation = rejectCrossOriginMutation(c.req.raw, [canonicalOrigin]);
    if (crossOriginMutation) {
      return withSensitiveCacheHeaders(withSecurityHeaders(crossOriginMutation), c.req.raw);
    }
  }

  const cspNonce = generateCspNonce();
  await requestContext.run({ cspNonce }, () => next());
  c.res = withSensitiveCacheHeaders(withSecurityHeaders(c.res, cspNonce), c.req.raw);
  return undefined;
});

// ── Auth (OAuth 2.1 + JWT) ────────────────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin UI (protected) ──────────────────────────────────────────────────────
app.route('/admin', adminRoutes);

// ── Plugin write-back API (F1, PLUGIN_SECRET-authenticated) ───────────────────
app.route('/__cms', cmsApiRoutes);

// ── Media files from optional R2 binding ──────────────────────────────────────
app.route('/', mediaRoutes);

app.get('/views/*', async (c) => {
  const path = c.req.path.slice('/views'.length);
  if (!path.startsWith('/') || path.includes('..')) return c.notFound();

  const response = await c.env.VIEWS.fetch(`https://views.local${path}`);
  if (!response.ok) return c.notFound();

  const headers = new Headers(response.headers);
  if (path.endsWith('.json')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  } else if (path.endsWith('.liquid')) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
  }
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
});

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

// ── Static assets (compiled CSS) from the VIEWS binding ──────────────────────
app.get('/assets/*', async (c) => {
  const assetPath = new URL(c.req.url).pathname;
  const response = await c.env.VIEWS.fetch(`https://views.local${assetPath}`);
  if (!response.ok) return c.notFound();
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(response.body, { status: response.status, headers });
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
app.notFound(async (c) => {
  return c.html(
    await errorPage(c.env.VIEWS, {
      status: 404,
      title: 'Not Found',
      heading: 'Page Not Found',
      siteTitle: c.env.SITE_TITLE ?? '0xCMS',
    }),
    404,
  );
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.onError(async (err, c) => {
  console.error(err);
  return c.html(
    await errorPage(c.env.VIEWS, {
      status: 500,
      title: 'Server Error',
      heading: 'Internal Server Error',
      message: 'Please try again later.',
      siteTitle: c.env.SITE_TITLE ?? '0xCMS',
    }),
    500,
  );
});

export default app;
export { PageSyncDO } from './durable-objects/page-sync';
