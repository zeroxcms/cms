import { Hono } from 'hono';
import { applyMediaResponseHeaders, mediaObjectResponse } from '../security/media';
import type { Env, Variables } from '../types';

export const mediaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Square thumbnail edge, in pixels, for the admin media pickers. */
const PREVIEW_SIZE = 100;
/** Images binding input ceiling; larger objects are served untransformed. */
const MAX_TRANSFORM_BYTES = 20 * 1024 * 1024;

mediaRoutes.get('/media-preview/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media-preview\//, '');

  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) return cached;

  const thumbnail = await thumbnailResponse(c.env, key);
  if (thumbnail) {
    c.executionCtx.waitUntil(cache.put(c.req.raw, thumbnail.clone()));
    return thumbnail;
  }

  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

mediaRoutes.get('/media/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media\//, '');
  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

/**
 * Resize an R2 object to a square thumbnail via the Images binding. Returns
 * null whenever the transform cannot or should not run - no binding, missing
 * object, non-image, oversized input, or a decode failure - leaving the caller
 * to serve the original object instead.
 */
async function thumbnailResponse(env: Env, key: string): Promise<Response | null> {
  if (!env.IMAGES || !env.MEDIA_BUCKET) return null;

  const object = await env.MEDIA_BUCKET.get(key);
  if (!object) return null;
  if (object.size > MAX_TRANSFORM_BYTES) return null;

  const contentType = object.httpMetadata?.contentType?.split(';')[0].trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) return null;

  try {
    const result = await env.IMAGES
      .input(object.body)
      .transform({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, fit: 'cover' })
      .output({ format: 'image/webp' });

    const transformed = result.response();
    const headers = new Headers(transformed.headers);
    headers.set('Cache-Control', 'public, max-age=31536000');
    // Weak validator: derived from the source object, scoped to these params.
    headers.set('ETag', `W/"${object.etag}-${PREVIEW_SIZE}"`);
    applyMediaResponseHeaders(headers, key);
    return new Response(transformed.body, { headers });
  } catch {
    // The object body is spent at this point; the fallback re-reads from R2.
    return null;
  }
}
