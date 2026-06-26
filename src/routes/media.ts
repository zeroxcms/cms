import { Hono } from 'hono';
import { mediaObjectResponse } from '../security/media';
import type { Env, Variables } from '../types';

export const mediaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

mediaRoutes.get('/media-preview/*', async (c) => {
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

mediaRoutes.get('/media/*', async (c) => {
  if (!c.env.MEDIA_BUCKET) return c.notFound();
  const key = c.req.path.replace(/^\/media\//, '');
  return await mediaObjectResponse(c.env.MEDIA_BUCKET, key) ?? c.notFound();
});

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
