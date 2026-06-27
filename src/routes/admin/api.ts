// Admin JSON API endpoints and media upload.

import { Hono } from 'hono';
import { cmsConfig } from '../../cms-config';
import { getLectLocalizedValue, safeParseLect } from '../../utils/lect';
import type { Env, Variables, Tag, Taxonomy } from '../../types';
import { num, slugify, str } from '../../utils/forms';
import { validateUpload } from '../../security/media';
import { rateLimitByIP } from '../../middleware/rate-limit';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import type { AppContext } from '../../utils/context';

export const apiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

apiRoutes.get('/api/parent-pages', requirePermission('content:read'), async (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const excludeId = num(c.req.query('exclude'), 0);
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    conditions.push('(name LIKE ? OR slug LIKE ?)');
    params.push(term, term);
  }

  if (excludeId) {
    conditions.push('id != ?');
    params.push(excludeId);
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pages = await c.env.DB.prepare(
    `SELECT id, name, slug
     FROM draft_pages
     ${whereSql}
     ORDER BY updated_at DESC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<{ id: number; name: string; slug: string }>();

  return c.json(pages.results.map((page) => ({
    id: page.id,
    name: page.name,
    slug: page.slug,
    label: `/${page.slug}`,
  })));
});

// Pages of a given type, for the page-reference field's search combobox
// (views/snippets/pagefield/page/basic.liquid). `q` filters by name/slug; `id`
// resolves a single page (used to label the current selection). With neither,
// returns the most-recently-updated pages of the type.
apiRoutes.get('/api/pages/:type', requirePermission('content:read'), async (c) => {
  const pageType = c.req.param('type');
  const query = c.req.query('q')?.trim() ?? '';
  const id = num(c.req.query('id'), 0);

  const conditions = ['page_type = ?'];
  const params: unknown[] = [pageType];
  if (id) {
    conditions.push('id = ?');
    params.push(id);
  } else if (query) {
    const term = `%${query.replaceAll(' ', '%')}%`;
    conditions.push('(name LIKE ? OR slug LIKE ?)');
    params.push(term, term);
  }

  const pages = await c.env.DB.prepare(
    `SELECT id, name, slug
     FROM draft_pages
     WHERE ${conditions.join(' AND ')}
     ORDER BY updated_at DESC, name ASC
     LIMIT 20`,
  )
    .bind(...params)
    .all<{ id: number; name: string; slug: string }>();

  return c.json(pages.results.map((page) => ({
    id: page.id,
    // `page` retained for backward compatibility with earlier callers.
    page: page.id,
    name: page.name,
    slug: page.slug,
    label: `/${page.slug}`,
  })));
});

apiRoutes.get('/api/tags/:type', requirePermission('content:read'), async (c) => {
  const type = c.req.param('type');
  const taxonomy = await c.env.DB.prepare('SELECT * FROM taxonomies WHERE name = ? OR slug = ?')
    .bind(type, type)
    .first<Taxonomy>();
  if (!taxonomy) return c.json([]);
  const tags = await c.env.DB.prepare('SELECT * FROM tags WHERE taxonomy_id = ? ORDER BY name ASC')
    .bind(taxonomy.id)
    .all<Tag>();
  return c.json(tags.results.map((tag) => ({
    value: tag.id,
    label: getLectLocalizedValue(safeParseLect(tag.lect), 'name', cmsConfig.defaultLanguage) || tag.name,
  })));
});

apiRoutes.post('/api/page/:pageId/tag/:tagId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  const tagId = parseInt(c.req.param('tagId'), 10);
  const existing = await c.env.DB.prepare(
    'SELECT id FROM draft_page_tags WHERE page_id = ? AND tag_id = ?',
  )
    .bind(pageId, tagId)
    .first<{ id: number }>();
  if (existing) {
    return c.json({ type: 'ADD_PAGE_TAG', payload: { success: false, message: 'tag exist', id: existing.id } });
  }
  const result = await c.env.DB.prepare('INSERT INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
    .bind(pageId, tagId)
    .run();
  const pageTag = await c.env.DB.prepare('SELECT id FROM draft_page_tags WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<{ id: number }>();
  await c.env.DB.prepare('UPDATE draft_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(pageId).run();
  return c.json({ type: 'ADD_PAGE_TAG', payload: { success: true, id: pageTag?.id } });
});

apiRoutes.delete('/api/page/remove/page_tag/:id', requirePermission('content:write'), async (c) => deletePageTagApi(c));
apiRoutes.delete('/api/page_tag/:id', requirePermission('content:write'), async (c) => deletePageTagApi(c));

async function deletePageTagApi(c: AppContext) {
  const id = parseInt(c.req.param('id') ?? '', 10);
  const pageTag = await c.env.DB.prepare('SELECT page_id FROM draft_page_tags WHERE id = ?')
    .bind(id)
    .first<{ page_id: number }>();
  await c.env.DB.prepare('DELETE FROM draft_page_tags WHERE id = ?').bind(id).run();
  if (pageTag) {
    await c.env.DB.prepare('UPDATE draft_pages SET updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(pageTag.page_id)
      .run();
  }
  return c.json({ type: 'DELETE_PAGE_TAG', payload: { success: true, id } });
}

// ── Lect CRDT sync (WebSocket) ────────────────────────────────────────────────

async function draftPageExists(c: AppContext, pageId: number): Promise<boolean> {
  const page = await c.env.DB.prepare('SELECT id FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<{ id: number }>();
  return !!page;
}

apiRoutes.get('/api/sync/:pageId', requirePermission('content:write'), async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.text('Invalid page ID', 400);
  if (!(await draftPageExists(c, pageId))) return c.text('Page not found', 404);

  const user = c.get('user');
  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    new Request(c.req.raw.url, {
      headers: {
        Upgrade: 'websocket',
        'X-User-Id': String(user.sub),
        'X-User-Name': user.name,
      },
    }),
  );
});

// ── Presence ─────────────────────────────────────────────────────────────────

apiRoutes.post('/api/presence/:pageId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  const user = c.get('user');
  const body = await c.req.json().catch(() => ({})) as { lastActive?: unknown; userAvatar?: unknown };
  const now = new Date().toISOString();

  // Presence is best-effort: invalid fields degrade to safe values rather
  // than failing the heartbeat.
  const lastActive = typeof body.lastActive === 'string'
    && body.lastActive.length <= 40
    && Number.isFinite(Date.parse(body.lastActive))
    ? body.lastActive
    : now;
  const userAvatar = typeof body.userAvatar === 'string'
    && body.userAvatar.length <= 512
    && /^(https:\/\/|\/media\/)/.test(body.userAvatar)
    ? body.userAvatar
    : null;

  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': String(user.sub),
        'X-User-Name': user.name,
      },
      body: JSON.stringify({ lastSeen: now, lastActive, userAvatar }),
    },
  );
});

apiRoutes.get('/api/presence/:pageId', requirePermission('content:read'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
  );
});

apiRoutes.delete('/api/presence/:pageId', requirePermission('content:write'), async (c) => {
  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.json({ error: 'invalid_page_id' }, 400);
  if (!(await draftPageExists(c, pageId))) return c.json({ error: 'page_not_found' }, 404);

  const user = c.get('user');
  return c.env.PAGE_SYNC.get(c.env.PAGE_SYNC.idFromName(`page-${pageId}`)).fetch(
    'https://page-sync/?action=presence',
    {
      method: 'DELETE',
      headers: { 'X-User-Id': String(user.sub) },
    },
  );
});

// ── Upload ───────────────────────────────────────────────────────────────────

apiRoutes.use('/upload', rateLimitByIP((env) => env.UPLOAD_RATE_LIMITER));
apiRoutes.use('/upload', requirePermission('media:upload'));

apiRoutes.post('/upload', async (c) => {
  if (!c.env.MEDIA_BUCKET) {
    return c.json({ success: false, error: 'MEDIA_BUCKET binding is not configured' }, 501);
  }

  const form = await c.req.formData();
  const uploadDirectory = slugify(str(form.get('dir')) || 'upload') || 'upload';
  const now = new Date();
  const datePath = `${now.getUTCFullYear()}/${now.getUTCMonth() + 1}/${now.getUTCDate()}`;
  const files: string[] = [];
  const errors: Array<{ file: string; error: string }> = [];
  let errorStatus: 413 | 415 | undefined;

  for (const [, value] of form.entries()) {
    if (typeof value === 'string') continue;
    const file = value as File;
    if (!file.name) continue;

    const headerBytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const validation = validateUpload(file, headerBytes);
    if (!validation.ok) {
      errors.push({ file: file.name, error: validation.error });
      errorStatus = errorStatus ?? validation.status;
      continue;
    }

    const safeName = file.name.replace(/[^a-z0-9-_.]/gi, '');
    const key = `${uploadDirectory}/${datePath}/${crypto.randomUUID()}-${safeName}`;
    await c.env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: { contentType: validation.contentType },
    });
    const url = `/media/${key}`;
    await c.env.DB.prepare(
      'INSERT INTO media_files (key, url, filename, content_type, size) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(key, url, file.name, validation.contentType, file.size)
      .run();
    logAudit(c, 'media.upload', 'media', key, { filename: file.name, size: file.size });
    files.push(url);
  }

  if (errors.length > 0 && files.length === 0) {
    return c.json({ success: false, files, errors }, errorStatus ?? 415);
  }
  return c.json({ success: true, files, errors });
});
