// Admin JSON API endpoints and media upload.

import { Hono } from 'hono';
import { cmsConfig } from '../../cms-config';
import { getLectLocalizedValue, safeParseLect } from '../../utils/lect';
import type { Env, Variables, Tag, TagType } from '../../types';
import { num, slugify, str } from '../../utils/forms';
import { validateUpload } from '../../utils/media';
import { rateLimitByIP } from '../../middleware/rate-limit';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import type { AppContext } from '../../utils/context';

export const apiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

apiRoutes.get('/api/parent-pages', async (c) => {
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

apiRoutes.get('/api/pages/:type', async (c) => {
  const pageType = c.req.param('type');
  const pages = await c.env.DB.prepare('SELECT id, name FROM draft_pages WHERE page_type = ? ORDER BY name ASC')
    .bind(pageType)
    .all<{ id: number; name: string }>();
  return c.json(pages.results.map((page) => ({ page: page.id, name: page.name })));
});

apiRoutes.get('/api/tags/:type', async (c) => {
  const type = c.req.param('type');
  const tagType = await c.env.DB.prepare('SELECT * FROM tag_types WHERE name = ? OR slug = ?')
    .bind(type, type)
    .first<TagType>();
  if (!tagType) return c.json([]);
  const tags = await c.env.DB.prepare('SELECT * FROM tags WHERE tag_type_id = ? ORDER BY name ASC')
    .bind(tagType.id)
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

apiRoutes.get('/api/sync/:pageId', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }

  const pageId = parseInt(c.req.param('pageId'), 10);
  if (!Number.isFinite(pageId) || pageId <= 0) return c.text('Invalid page ID', 400);

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

apiRoutes.post('/api/presence/:pageId', async (c) => {
  const pageId = Number(c.req.param('pageId'));
  const user = c.get('user');
  const body = await c.req.json<{ lastActive?: unknown; userAvatar?: unknown }>();
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

  await c.env.DB.prepare(
    `INSERT INTO presence (user_id, user_name, user_avatar, page_id, last_seen, last_active)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, page_id) DO UPDATE SET
       last_seen   = excluded.last_seen,
       last_active = excluded.last_active,
       user_avatar = excluded.user_avatar`,
  ).bind(String(user.sub), user.name, userAvatar, pageId, now, lastActive).run();

  await c.env.DB.prepare(
    `DELETE FROM presence WHERE page_id = ? AND last_seen < datetime('now', '-10 minutes')`,
  ).bind(pageId).run();

  return c.json({ ok: true });
});

apiRoutes.get('/api/presence/:pageId', async (c) => {
  const pageId = Number(c.req.param('pageId'));
  const { results } = await c.env.DB.prepare(
    `SELECT user_id, user_name, user_avatar, last_seen, last_active
     FROM presence
     WHERE page_id = ? AND last_seen >= datetime('now', '-10 minutes')
     ORDER BY last_seen DESC`,
  ).bind(pageId).all<{ user_id: string; user_name: string; user_avatar: string | null; last_seen: string; last_active: string }>();
  return c.json(results);
});

apiRoutes.delete('/api/presence/:pageId', async (c) => {
  const pageId = Number(c.req.param('pageId'));
  const user = c.get('user');
  await c.env.DB.prepare(
    `DELETE FROM presence WHERE user_id = ? AND page_id = ?`,
  ).bind(String(user.sub), pageId).run();
  return c.json({ ok: true });
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
