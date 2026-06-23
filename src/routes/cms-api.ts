// ============================================================
// F1 — Plugin → CMS page write-back / read API.
//
// The standard plugin contract is CMS → plugin only (manifest, admin proxy,
// hooks, publish snapshots). This router adds the reverse channel: a trusted
// plugin Worker can read and write the CMS pages whose content types it owns,
// so guest-facing flows that live on the plugin's own domain (public RSVP
// submit, QR check-in, bulk contact import) can create/update guest pages in
// the single source of truth.
//
// Transport & trust:
//   - Mounted at the reserved /__cms prefix, OUTSIDE the /admin auth stack
//     (there is no signed-in user — this is server-to-server).
//   - Authenticated by the shared PLUGIN_SECRET (x-plugin-secret header), the
//     same secret the CMS forwards to plugins for hooks/admin/publish.
//   - The caller names itself via x-plugin-id; writes are scoped to that
//     plugin's manifest blueprint page types. Because every plugin shares one
//     PLUGIN_SECRET, this scoping is a guardrail among co-operating trusted
//     plugins, not a hard boundary — only register trusted plugin URLs.
//   - The global cross-origin mutation guard is bypassed for /__cms (see
//     index.ts): server-to-server callers send no Origin, and PLUGIN_SECRET is
//     the real authenticator here.
//
// Every create/update/delete mints a page_version and fires the matching
// lifecycle hook, exactly like the admin editor — so plugin writes are
// versioned, auditable, and observable to other plugins.
// ============================================================

import { Hono } from 'hono';
import type { AppContext } from '../utils/context';
import type { Env, Variables, Page, ResolvedPlugin } from '../types';
import { resolveCmsConfig } from '../plugins/config';
import { pluginById } from '../plugins/registry';
import { deliverHook, type HookEvent, type HookPage } from '../plugins/hooks';
import { blueprintToLect, mergeLects, safeParseLect, stringifyLect } from '../utils/lect';
import type { Lect } from '../utils/lect';
import { withDraftMetadata } from '../utils/page-logic';
import { ensureUniqueDraftSlug, savePageVersion, trashDraftPage } from '../utils/admin-queries';
import { slugify } from '../utils/forms';
import { unpublishPageFromTargets } from '../publish';

export const cmsApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Largest batch accepted by POST /pages/batch — bounds D1 write volume per call. */
const MAX_BATCH = 200;

interface ApiPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Lect;
}

interface PluginAuth {
  plugin: ResolvedPlugin;
  pluginId: string;
  /** Page types this plugin declared in its manifest blueprint — the write scope. */
  allowedTypes: Set<string>;
  /** Owned types plus any declared `readTypes` — the (wider) read scope. */
  readableTypes: Set<string>;
}

/** Body accepted by create/update. All fields optional on update; `page_type` required on create. */
interface PageInput {
  page_type?: unknown;
  name?: unknown;
  slug?: unknown;
  lect?: unknown;
  weight?: unknown;
  start?: unknown;
  end?: unknown;
  page_id?: unknown;
  tags?: unknown;
}

// ── Auth + scoping ────────────────────────────────────────────────────────────

/**
 * Verifies the shared secret and resolves the calling plugin so writes can be
 * scoped to the page types it owns. Returns a Response (to short-circuit) on
 * any failure, otherwise the resolved plugin + its allowed page types.
 */
async function authenticatePlugin(c: AppContext): Promise<PluginAuth | Response> {
  // Resolve the caller first so we can check its OWN secret: per-plugin secrets
  // make this scope a real boundary, and let one plugin be rotated/revoked
  // without touching the others.
  const pluginId = (c.req.header('x-plugin-id') ?? '').trim();
  if (!pluginId) return c.json({ error: 'missing_plugin_id' }, 400);

  const plugin = await pluginById(c.env, pluginId);
  if (!plugin) return c.json({ error: 'unknown_plugin' }, 403);

  if (!plugin.secret) {
    console.error(`Plugin ${pluginId} called the write-back API but has no secret configured`);
    return c.json({ error: 'plugin_api_unavailable' }, 503);
  }
  if (c.req.header('x-plugin-secret') !== plugin.secret) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const allowedTypes = new Set(Object.keys(plugin.manifest.contentTypes?.blueprint ?? {}));
  // Reads may also reach declared `readTypes` (pages owned by other plugins).
  const readableTypes = new Set(allowedTypes);
  for (const type of plugin.manifest.contentTypes?.readTypes ?? []) readableTypes.add(type);
  return { plugin, pluginId, allowedTypes, readableTypes };
}

// ── Serialization ─────────────────────────────────────────────────────────────

function serializePage(page: Page): ApiPage {
  return {
    id: page.id,
    uuid: page.uuid,
    page_type: page.page_type,
    name: page.name,
    slug: page.slug,
    weight: page.weight,
    start: page.start,
    end: page.end,
    page_id: page.page_id,
    created_at: page.created_at,
    updated_at: page.updated_at,
    lect: safeParseLect(page.lect),
  };
}

/** Accepts lect as a parsed object or a JSON string; anything else becomes empty. */
function coerceLect(value: unknown): Lect {
  if (!value) return {};
  if (typeof value === 'string') return safeParseLect(value);
  if (typeof value === 'object') return value as Lect;
  return {};
}

function asFiniteNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── Lifecycle hook + audit (plugin actor, no signed-in user) ──────────────────

/**
 * Fires the lifecycle hook to subscribed plugins and records an audit row, both
 * best-effort via waitUntil. Mirrors dispatchHook but attributes the action to
 * the calling plugin instead of a CMS user (logAudit needs a user, so we can't
 * reuse it here).
 */
function emitPluginHook(c: AppContext, event: HookEvent, page: HookPage, pluginId: string): void {
  const auditPromise = c.env.DB.prepare(
    `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      '0',
      `plugin:${pluginId}`,
      `page.${event}`,
      'page',
      String(page.id),
      JSON.stringify({ name: page.name, slug: page.slug, page_type: page.page_type, via: `plugin:${pluginId}` }),
    )
    .run()
    .catch((error) => console.error('audit log failed', error));

  // deliverHook tolerates a null user (passes user: null in the payload).
  const hookPromise = deliverHook(c.env, undefined, event, page);

  const combined = Promise.allSettled([auditPromise, hookPromise]);
  try {
    c.executionCtx.waitUntil(combined);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let it run detached.
    void combined;
  }
}

// Tell the page's sync Durable Object the page was saved so any open editor's
// CRDT overlay commits rather than reverting. Best-effort — never blocks a write.
async function notifyPageSaved(env: Env, pageId: number): Promise<void> {
  try {
    const id = env.PAGE_SYNC.idFromName(`page-${pageId}`);
    await env.PAGE_SYNC.get(id).fetch('https://page-sync/?action=saved', { method: 'POST' });
  } catch {
    // Sync is a non-critical overlay.
  }
}

// ── Create (shared by POST /pages and POST /pages/batch) ──────────────────────

type CreateResult = { ok: true; page: ApiPage } | { ok: false; status: number; error: string };

async function createPage(
  c: AppContext,
  auth: PluginAuth,
  input: PageInput,
): Promise<CreateResult> {
  const pageType = typeof input.page_type === 'string' ? input.page_type : '';
  if (!pageType) return { ok: false, status: 400, error: 'page_type_required' };
  if (!auth.allowedTypes.has(pageType)) return { ok: false, status: 403, error: 'forbidden_page_type' };

  const config = await resolveCmsConfig(c.env);
  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim()
    : `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const desiredSlug = typeof input.slug === 'string' && input.slug.trim()
    ? slugify(input.slug)
    : slugify(name);
  const slug = await ensureUniqueDraftSlug(c.env.DB, desiredSlug || slugify(name) || pageType);

  const lect = stringifyLect(
    withDraftMetadata(
      mergeLects(
        blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
        coerceLect(input.lect),
      ),
      0,
    ),
  );
  const weight = asFiniteNumber(input.weight) ?? 5;
  const start = typeof input.start === 'string' ? input.start : null;
  const end = typeof input.end === 'string' ? input.end : null;
  const parentId = asFiniteNumber(input.page_id);

  const result = await c.env.DB.prepare(
    `INSERT INTO draft_pages (name, slug, weight, start, end, page_type, lect, page_id, creator)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, slug, weight, start, end, pageType, lect, parentId, null)
    .run();

  // Custom DEFAULT id expression means last_row_id is the rowid; SELECT the id back.
  const row = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE rowid = ?')
    .bind(result.meta.last_row_id)
    .first<Page>();
  if (!row) return { ok: false, status: 500, error: 'create_failed' };

  const versionId = await savePageVersion(c.env.DB, row.id, lect, 'create');
  await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
    .bind(versionId, row.id)
    .run();

  await applyTagList(c, row.id, input.tags, false);

  emitPluginHook(c, 'create', { id: row.id, uuid: row.uuid, page_type: pageType, name, slug }, auth.pluginId);
  return { ok: true, page: serializePage(row) };
}

/** Sets a page's tag links from a list of numeric tag ids. On update, `replace` clears existing first. */
async function applyTagList(c: AppContext, pageId: number, tags: unknown, replace: boolean): Promise<void> {
  if (!Array.isArray(tags)) return;
  if (replace) {
    await c.env.DB.prepare('DELETE FROM draft_page_tags WHERE page_id = ?').bind(pageId).run();
  }
  for (const raw of tags) {
    const tagId = asFiniteNumber(raw);
    if (tagId === null) continue;
    await c.env.DB.prepare('INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
      .bind(pageId, tagId)
      .run();
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// List pages of a content type the plugin owns.
cmsApiRoutes.get('/pages', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const pageType = (c.req.query('page_type') ?? '').trim();
  if (!pageType) return c.json({ error: 'page_type_required' }, 400);
  if (!auth.readableTypes.has(pageType)) return c.json({ error: 'forbidden_page_type' }, 403);

  const limit = Math.min(Math.max(asFiniteNumber(c.req.query('limit')) ?? 50, 1), 500);
  const offset = Math.max(asFiniteNumber(c.req.query('offset')) ?? 0, 0);
  const q = (c.req.query('q') ?? '').trim();
  // Optional parent filter: e.g. all `guest` pages belonging to one event.
  const parentId = asFiniteNumber(c.req.query('page_id'));

  const params: unknown[] = [pageType];
  let where = 'WHERE page_type = ?';
  if (parentId !== null) {
    where += ' AND page_id = ?';
    params.push(parentId);
  }
  if (q) {
    where += ' AND (name LIKE ? OR slug LIKE ?)';
    const term = `%${q.replaceAll(' ', '%')}%`;
    params.push(term, term);
  }

  const [rows, totalRow] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM draft_pages ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...params, limit, offset)
      .all<Page>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM draft_pages ${where}`)
      .bind(...params)
      .first<{ total: number }>(),
  ]);

  return c.json({
    pages: rows.results.map(serializePage),
    total: totalRow?.total ?? 0,
    limit,
    offset,
  });
});

// Read a single page (scoped to the plugin's content types).
cmsApiRoutes.get('/pages/:id', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(id).first<Page>();
  if (!page) return c.json({ error: 'not_found' }, 404);
  if (!auth.readableTypes.has(page.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

  const tags = await c.env.DB.prepare('SELECT tag_id FROM draft_page_tags WHERE page_id = ?')
    .bind(id)
    .all<{ tag_id: number }>();

  return c.json({ page: { ...serializePage(page), tags: tags.results.map((t) => t.tag_id) } });
});

// Create a page.
cmsApiRoutes.post('/pages', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const result = await createPage(c, auth, body);
  if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 403 | 500);
  return c.json({ page: result.page }, 201);
});

// Batch-create pages (bulk import / bulk add-to-list). Each entry may carry its
// own page_type; all must be within the plugin's scope.
cmsApiRoutes.post('/pages/batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { pages?: unknown } | null;
  const items = body && Array.isArray(body.pages) ? body.pages : null;
  if (!items) return c.json({ error: 'invalid_body' }, 400);
  if (items.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  const created: ApiPage[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const result = await createPage(c, auth, (items[i] ?? {}) as PageInput);
    if (result.ok) created.push(result.page);
    else errors.push({ index: i, error: result.error });
  }

  return c.json({ created, errors, count: created.length });
});

// Update a page (PUT/PATCH are equivalent here — both partial-merge).
cmsApiRoutes.put('/pages/:id', (c) => updatePage(c));
cmsApiRoutes.patch('/pages/:id', (c) => updatePage(c));

async function updatePage(c: AppContext): Promise<Response> {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  const page = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(id).first<Page>();
  if (!page) return c.json({ error: 'not_found' }, 404);
  if (!auth.allowedTypes.has(page.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

  const body = await c.req.json().catch(() => null) as PageInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const config = await resolveCmsConfig(c.env);
  const pageType = page.page_type ?? 'default';

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : page.name;
  const slug = typeof body.slug === 'string' && body.slug.trim()
    ? await ensureUniqueDraftSlug(c.env.DB, slugify(body.slug), id)
    : page.slug;

  // Merge: blueprint defaults ← stored lect ← incoming partial lect, so callers
  // can send just the fields they changed.
  const mergedLect = 'lect' in body
    ? mergeLects(
        mergeLects(blueprintToLect(pageType, config.blueprint, config.defaultLanguage), safeParseLect(page.lect)),
        coerceLect(body.lect),
      )
    : safeParseLect(page.lect);
  const lectVal = stringifyLect(withDraftMetadata(mergedLect, 0));

  const weight = asFiniteNumber(body.weight) ?? page.weight;
  const start = 'start' in body ? (typeof body.start === 'string' ? body.start : null) : page.start;
  const end = 'end' in body ? (typeof body.end === 'string' ? body.end : null) : page.end;
  const parentId = 'page_id' in body ? asFiniteNumber(body.page_id) : page.page_id;

  await c.env.DB.prepare(
    'UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, lect=?, page_id=? WHERE id=?',
  )
    .bind(name, slug, weight, start, end, lectVal, parentId, id)
    .run();

  const versionId = await savePageVersion(c.env.DB, id, lectVal, 'update');
  await c.env.DB.prepare('UPDATE draft_pages SET current_page_version_id = ? WHERE id = ?')
    .bind(versionId, id)
    .run();

  if ('tags' in body) await applyTagList(c, id, body.tags, true);

  await notifyPageSaved(c.env, id);

  const updated = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(id).first<Page>();
  emitPluginHook(c, 'update', { id, uuid: page.uuid, page_type: pageType, name, slug }, auth.pluginId);
  return c.json({ page: serializePage(updated!) });
}

// Soft-delete a page to trash.
cmsApiRoutes.delete('/pages/:id', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const id = asFiniteNumber(c.req.param('id'));
  if (id === null) return c.json({ error: 'invalid_id' }, 400);

  // Read first so we can enforce scope before trashing.
  const existing = await c.env.DB.prepare('SELECT page_type FROM draft_pages WHERE id = ?')
    .bind(id)
    .first<{ page_type: string | null }>();
  if (!existing) return c.json({ error: 'not_found' }, 404);
  if (!auth.allowedTypes.has(existing.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

  const page = await trashDraftPage(c.env.DB, id);
  if (!page) return c.json({ error: 'not_found' }, 404);

  await unpublishPageFromTargets(c.env, page.uuid);
  emitPluginHook(
    c,
    'delete',
    { id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug },
    auth.pluginId,
  );

  return c.json({ ok: true, id: page.id });
});
