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
import { applyMediaResponseHeaders } from './utils/media';
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
      return withSecurityHeaders(new Response('Server misconfigured', { status: 500 }));
    }
  }

  const canonicalOrigin = c.env.CANONICAL_ORIGIN ?? 'https://cms.eventuai.com';
  const canonicalResponse = canonicalHostResponse(
    c.req.raw,
    canonicalOrigin,
  );
  if (canonicalResponse) return withSecurityHeaders(canonicalResponse);

  const crossOriginMutation = rejectCrossOriginMutation(c.req.raw, [canonicalOrigin]);
  if (crossOriginMutation) return withSecurityHeaders(crossOriginMutation);

  const cspNonce = generateCspNonce();
  await requestContext.run({ cspNonce }, () => next());
  c.res = withSecurityHeaders(c.res, cspNonce);
  return undefined;
});

// ── Auth (OAuth 2.1 + JWT) ────────────────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Admin UI (protected) ──────────────────────────────────────────────────────
app.route('/admin', adminRoutes);

// ── Media files from optional R2 binding ──────────────────────────────────────
app.get('/media-preview/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media-preview\//, '');
  const mediaUrl = new URL(`/media/${key}`, c.req.url);

  if (!isLocalHost(mediaUrl.hostname)) {
    try {
      const resized = await fetch(mediaUrl.toString(), {
        cf: {
          image: {
            width: 100,
            height: 100,
            fit: 'cover',
          },
        },
      });
      if (resized.ok) return resized;
    } catch {
      // Fall back to the original R2 object when Image Resizing is unavailable.
    }
  }

  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

app.get('/media/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media\//, '');
  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

async function mediaObjectResponse(bucket: R2Bucket, key: string): Promise<Response | null> {
  const object = await bucket.get(key);
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('ETag', object.httpEtag);
  applyMediaResponseHeaders(headers, key);
  return new Response(object.body, { headers });
}

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
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
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
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
    }),
    500,
  );
});

export default app;
export { PageSyncDO } from './durable-objects/page-sync';
