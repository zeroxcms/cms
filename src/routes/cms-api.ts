// ============================================================
// F1 — Plugin → CMS page write-back / read API.
//
// The standard plugin contract is CMS → plugin only (manifest, admin proxy,
// hooks, publish snapshots). This router adds the reverse channel: a trusted
// plugin Worker can read and write the CMS pages it owns or has been delegated,
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
//     plugin's manifest blueprint page types plus explicit, admin-approved
//     `writeTypes`. Because every plugin shares one PLUGIN_SECRET, this scoping
//     is a guardrail among co-operating trusted plugins, not a hard boundary —
//     only register trusted plugin URLs.
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
import { ensureUniqueDraftSlug, trashDraftPage, trashDraftPages } from '../utils/admin-queries';
import { slugify } from '../utils/forms';
import { chineseSearchVariants } from '../utils/chinese';
import { unpublishPageFromTargets } from '../publish';
import { notifyPageSaved, savePageVersionAndSetCurrent, setDraftPageTags } from '../utils/page-store';
import { listPageTypeApprovals, pageTypeScopeAllows } from '../utils/plugin-page-types';
import {
  checkCreateLimits,
  countLimitUsage,
  createCandidate,
  effectiveLimitsForPlugin,
  type LimitViolation,
} from '../utils/plugin-limits';
import {
  chargeCredits,
  effectiveCreditsForPlugin,
  getCreditBalance,
  pageCreateAction,
  pageCreateCostForType,
  refundCredits,
} from '../utils/credits';

export const cmsApiRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Largest batch accepted by POST /pages/batch — bounds D1 write volume per call. */
const MAX_BATCH = 100;

/** Rows per DB.batch in POST /pages/duplicate. */
const DUPLICATE_BATCH = 100;
/** Max children cloned in one POST /pages/duplicate request before yielding a cursor. */
const DUPLICATE_MAX_PER_CALL = 1000;

/** Rows trashed per DB.batch in DELETE /pages/children. */
const DELETE_CHILDREN_BATCH = 100;
/** Max children trashed in one DELETE /pages/children request before yielding (done:false). */
const DELETE_CHILDREN_MAX_PER_CALL = 1000;

const CMS_ID_EPOCH_OFFSET = 1563741060;

/** Body accepted by POST /pages/duplicate — clone a related collection with a transform. */
interface DuplicateInput {
  /** Only pages of this type are cloned (must be in the plugin's write scope). */
  source_page_type?: unknown;
  // Source selector (exactly one): by lect pointer (preferred) or parent page id.
  /** Pointer key the source pages group by, e.g. 'mail_list'. */
  source_pointer_key?: unknown;
  /** Pointer value the source pages group by, e.g. the list id. */
  source_pointer_value?: unknown;
  /** Parent page whose children are cloned (fallback when no pointer is given). */
  source_page_id?: unknown;
  /** Parent assigned to the clones (null/omitted → top-level). */
  target_page_id?: unknown;
  /** Lect fields merged over each clone (e.g. status reset, repointed `_pointers`). */
  lect?: unknown;
  /** Top-level lect keys stripped from each clone before the override merge. */
  drop_lect?: unknown;
  /** Resume token from a prior response's `next_cursor` (last source id copied). */
  cursor?: unknown;
}

interface ApiPage {
  id: number;
  uuid: string;
  page_type: string | null;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Lect;
}

interface PluginAuth {
  plugin: ResolvedPlugin;
  pluginId: string;
  /** Page types this plugin may write through its manifest-declared scope; `*` means any concrete page type. */
  allowedTypes: Set<string>;
  /** Writable types plus any declared `readTypes`; `*` means any concrete page type. */
  readableTypes: Set<string>;
}

/** Body accepted by create/update. All fields optional on update; `page_type` required on create. */
interface PageInput {
  id?: unknown;
  page_type?: unknown;
  name?: unknown;
  slug?: unknown;
  lect?: unknown;
  weight?: unknown;
  start?: unknown;
  end?: unknown;
  timezone?: unknown;
  page_id?: unknown;
  tags?: unknown;
}

interface PreparedCreate {
  id: number | null;
  pageType: string;
  name: string;
  baseSlug: string;
  lect: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  parentId: number | null;
  tags: number[];
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

  const contentTypes = plugin.manifest.contentTypes;
  const allowedTypes = new Set(Object.keys(contentTypes?.blueprint ?? {}));
  const approvals = await listPageTypeApprovals(c.env.DB, plugin.manifest.id);
  const approvedReadTypes = new Set(approvals.filter((approval) => approval.access === 'read').map((approval) => approval.page_type));
  const approvedWriteTypes = new Set(approvals.filter((approval) => approval.access === 'write').map((approval) => approval.page_type));
  for (const type of contentTypes?.writeTypes ?? []) {
    if (approvedWriteTypes.has(type)) allowedTypes.add(type);
  }
  // Reads may also reach admin-approved `readTypes` (pages owned by other plugins).
  const readableTypes = new Set(allowedTypes);
  for (const type of contentTypes?.readTypes ?? []) {
    if (approvedReadTypes.has(type)) readableTypes.add(type);
  }
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
    timezone: page.timezone,
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
  // Treat null/undefined/'' as "no value" — Number() maps all three to 0/NaN,
  // and a stray 0 here would bind page_id=0 and break the draft_pages self-FK.
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * WHERE fragment selecting a related collection of pages for the bulk
 * clone/delete endpoints — by a lect pointer (the way plugins actually group
 * sub-collections, e.g. guests by `_pointers.mail_list`) or, failing that, by
 * parent page id. The pointer is preferred because parent (`page_id`) is not
 * guaranteed to track the reference. Exactly one selector must be supplied.
 */
function collectionWhere(
  parentId: number | null,
  pointerKey: string,
  pointerValue: string,
): { ok: true; sql: string; params: unknown[] } | { ok: false; error: string } {
  const hasParent = parentId !== null;
  const hasPointer = pointerKey !== '' || pointerValue !== '';
  if (hasParent && hasPointer) return { ok: false, error: 'ambiguous_selector' };
  if (!hasParent && !hasPointer) return { ok: false, error: 'selector_required' };
  if (hasPointer) {
    if (!pointerKey || !pointerValue) return { ok: false, error: 'pointer_key_and_value_required_together' };
    if (!/^[a-z0-9_-]+$/i.test(pointerKey)) return { ok: false, error: 'invalid_pointer_key' };
    // json_extract path is parameterised below; the key is validated above.
    return { ok: true, sql: 'json_extract(lect, ?) = ?', params: [`$._pointers.${pointerKey}`, pointerValue] };
  }
  return { ok: true, sql: 'page_id = ?', params: [parentId] };
}

// ── Lifecycle hook + audit (plugin actor, no signed-in user) ──────────────────

/**
 * Fires the lifecycle hook to subscribed plugins and records an audit row, both
 * best-effort via waitUntil. Mirrors dispatchHook but attributes the action to
 * the calling plugin instead of a CMS user (logAudit needs a user, so we can't
 * reuse it here).
 */
function emitPluginHook(c: AppContext, event: HookEvent, page: HookPage, pluginId: string): void {
  emitPluginHooks(c, event, [page], pluginId);
}

function emitPluginHooks(c: AppContext, event: HookEvent, pages: HookPage[], pluginId: string): void {
  if (!pages.length) return;

  const auditPromise = c.env.DB.batch(
    pages.map((page) => c.env.DB.prepare(
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
      )),
  ).catch((error) => console.error('audit log failed', error));

  // deliverHook tolerates a null user (passes user: null in the payload).
  const hookPromise = Promise.all(pages.map((page) => deliverHook(c.env, undefined, event, page)));

  const combined = Promise.allSettled([auditPromise, hookPromise]);
  try {
    c.executionCtx.waitUntil(combined);
  } catch {
    // No ExecutionContext (e.g. unit tests) — let it run detached.
    void combined;
  }
}

// ── Create (shared by POST /pages and POST /pages/batch) ──────────────────────

type CreateResult =
  | { ok: true; page: ApiPage }
  | { ok: false; status: number; error: string; violation?: LimitViolation; credit?: { required: number; balance: number } };

/**
 * The user a plugin acts on behalf of, echoed back from the `x-cms-user`
 * summary the admin proxy forwards. Absent on flows with no signed-in user
 * (public RSVP submit, kiosk check-in) — those are uncharged in v1.
 */
function actingUserId(c: AppContext): number | null {
  return asFiniteNumber((c.req.header('x-acting-user-id') ?? '').trim() || null);
}
type PrepareCreateResult = { ok: true; input: PreparedCreate } | { ok: false; status: number; error: string };

function prepareCreateInput(
  c: AppContext,
  auth: PluginAuth,
  config: Awaited<ReturnType<typeof resolveCmsConfig>>,
  input: PageInput,
): PrepareCreateResult {
  const pageType = typeof input.page_type === 'string' ? input.page_type : '';
  if (!pageType) return { ok: false, status: 400, error: 'page_type_required' };
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return { ok: false, status: 403, error: 'forbidden_page_type' };

  const name = typeof input.name === 'string' && input.name.trim()
    ? input.name.trim()
    : `Untitled ${pageType.replace(/[_-]/g, ' ')}`;
  const desiredSlug = typeof input.slug === 'string' && input.slug.trim()
    ? slugify(input.slug)
    : slugify(name);
  const baseSlug = desiredSlug || slugify(name) || pageType;
  const lect = stringifyLect(
    withDraftMetadata(
      mergeLects(
        blueprintToLect(pageType, config.blueprint, config.defaultLanguage),
        coerceLect(input.lect),
      ),
      0,
    ),
  );

  return {
    ok: true,
    input: {
      id: asFiniteNumber(input.id),
      pageType,
      name,
      baseSlug,
      lect,
      weight: asFiniteNumber(input.weight) ?? 5,
      start: typeof input.start === 'string' ? input.start : null,
      end: typeof input.end === 'string' ? input.end : null,
      timezone: typeof input.timezone === 'string' ? input.timezone : (c.env.DEFAULT_TIMEZONE ?? '+0800'),
      parentId: asFiniteNumber(input.page_id),
      tags: tagIds(input.tags),
    },
  };
}

function tagIds(tags: unknown): number[] {
  if (!Array.isArray(tags)) return [];
  return tags.map(asFiniteNumber).filter((tagId): tagId is number => tagId !== null);
}

async function createPage(
  c: AppContext,
  auth: PluginAuth,
  input: PageInput,
): Promise<CreateResult> {
  const config = await resolveCmsConfig(c.env);
  const prepared = prepareCreateInput(c, auth, config, input);
  if (!prepared.ok) return prepared;
  const preparedInput = prepared.input;

  const violation = await checkCreateLimits(c.env, [
    createCandidate(preparedInput.pageType, preparedInput.parentId, preparedInput.lect),
  ]);
  if (violation) return { ok: false, status: 409, error: 'limit_exceeded', violation };

  // Charge the acting user before inserting (deduct-then-create keeps the
  // balance authoritative); a downstream failure refunds via the catch below.
  const cost = await pageCreateCostForType(c.env, preparedInput.pageType);
  const payer = actingUserId(c);
  const chargeAction = pageCreateAction(preparedInput.pageType, cost);
  let charged = 0;
  if (cost.total > 0 && payer !== null) {
    const charge = await chargeCredits(c.env, {
      userId: payer,
      amount: cost.total,
      action: chargeAction,
      entityType: preparedInput.pageType,
      pluginId: auth.pluginId,
      createdBy: `plugin:${auth.pluginId}`,
    });
    if (!charge.ok) {
      if (charge.error === 'unknown_user') return { ok: false, status: 400, error: 'unknown_acting_user' };
      return {
        ok: false,
        status: 402,
        error: 'insufficient_credits',
        credit: { required: charge.required, balance: charge.balance },
      };
    }
    charged = cost.total;
  }

  try {
    const slug = await ensureUniqueDraftSlug(c.env.DB, preparedInput.baseSlug);

    const explicitId = preparedInput.id ?? cmsId(new Set<number>());
    await c.env.DB.prepare(
      `INSERT INTO draft_pages (id, name, slug, weight, start, end, timezone, page_type, lect, page_id, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        explicitId,
        preparedInput.name,
        slug,
        preparedInput.weight,
        preparedInput.start,
        preparedInput.end,
        preparedInput.timezone,
        preparedInput.pageType,
        preparedInput.lect,
        preparedInput.parentId,
        null,
      )
      .run();

    const row = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
      .bind(explicitId)
      .first<Page>();
    if (!row) {
      if (charged && payer !== null) {
        await refundCredits(c.env, { userId: payer, amount: charged, action: chargeAction, pluginId: auth.pluginId, createdBy: `plugin:${auth.pluginId}` });
      }
      return { ok: false, status: 500, error: 'create_failed' };
    }

    await savePageVersionAndSetCurrent(c.env.DB, row.id, preparedInput.lect, 'create');
    await setDraftPageTags(c.env.DB, row.id, preparedInput.tags, false);

    emitPluginHook(c, 'create', { id: row.id, uuid: row.uuid, page_type: preparedInput.pageType, name: preparedInput.name, slug }, auth.pluginId);
    return { ok: true, page: serializePage(row) };
  } catch (error) {
    if (charged && payer !== null) {
      await refundCredits(c.env, { userId: payer, amount: charged, action: chargeAction, pluginId: auth.pluginId, createdBy: `plugin:${auth.pluginId}` });
    }
    throw error;
  }
}

async function existingSlugSet(db: D1Database, baseSlugs: string[]): Promise<Set<string>> {
  const bases = [...new Set(baseSlugs)];
  const out = new Set<string>();
  for (let index = 0; index < bases.length; index += 25) {
    const chunk = bases.slice(index, index + 25);
    const where = chunk.map(() => '(slug = ? OR slug LIKE ?)').join(' OR ');
    const params = chunk.flatMap((base) => [base, `${base}-%`]);
    const rows = await db.prepare(`SELECT slug FROM draft_pages WHERE ${where}`)
      .bind(...params)
      .all<{ slug: string }>();
    for (const row of rows.results) out.add(row.slug);
  }
  return out;
}

function allocateSlug(baseSlug: string, used: Set<string>): string {
  let candidate = baseSlug;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function cmsTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function cmsId(used: Set<number>): number {
  const random = new Uint32Array(1);
  let id = 0;
  do {
    crypto.getRandomValues(random);
    id = ((Math.floor(Date.now() / 1000) - CMS_ID_EPOCH_OFFSET) * 100000) + (random[0] % 100000);
  } while (used.has(id));
  used.add(id);
  return id;
}

interface BulkPageRow {
  id: number;
  uuid: string;
  createdAt: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  pageType: string;
  versionId: number;
  lect: string;
  parentId: number | null;
}

/**
 * The draft_pages + page_versions INSERT pair for one bulk-created page.
 * Ids, uuids, and timestamps are assigned by the caller so a whole batch
 * commits in a single DB.batch without per-row SELECT-backs.
 */
function bulkPageInsertStatements(db: D1Database, row: BulkPageRow): D1PreparedStatement[] {
  return [
    db.prepare(
      `INSERT INTO draft_pages (id, uuid, created_at, updated_at, name, slug, weight, start, end, timezone, page_type, current_page_version_id, lect, page_id, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      row.id, row.uuid, row.createdAt, row.createdAt, row.name, row.slug, row.weight, row.start,
      row.end, row.timezone, row.pageType, row.versionId, row.lect, row.parentId, null,
    ),
    db.prepare(
      `INSERT INTO page_versions (id, uuid, created_at, updated_at, page_id, lect, action)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.versionId, crypto.randomUUID(), row.createdAt, row.createdAt, row.id, row.lect, 'create'),
  ];
}

// ── Routes ────────────────────────────────────────────────────────────────────

// The calling plugin's declared limits with effective values and current
// usage — read-only, for plugin UIs to show quotas ("1,240 / 2,000 guests")
// and pre-warn before bulk actions. Scoped usage needs the scope value:
// pass ?page_id= for per_parent limits and ?pointer_value= for per_pointer
// limits; without it those report usage: null. Enforcement stays host-side
// regardless of what a plugin does with this data.
cmsApiRoutes.get('/limits', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const limits = await effectiveLimitsForPlugin(c.env, auth.plugin);
  const pointerValue = (c.req.query('pointer_value') ?? '').trim();
  const parentId = asFiniteNumber(c.req.query('page_id'));

  const out = [];
  for (const limit of limits) {
    let usage: number | null = null;
    if (limit.def.scope === 'total') {
      usage = await countLimitUsage(c.env.DB, limit.def, null);
    } else if (limit.def.scope === 'per_parent' && parentId !== null) {
      usage = await countLimitUsage(c.env.DB, limit.def, parentId);
    } else if (limit.def.scope === 'per_pointer' && pointerValue) {
      usage = await countLimitUsage(c.env.DB, limit.def, pointerValue);
    }
    out.push({
      key: limit.def.key,
      label: limit.def.label,
      description: limit.def.description,
      page_type: limit.def.pageType,
      scope: limit.def.scope,
      pointer_key: limit.def.pointerKey,
      value: limit.value,
      configured: limit.configured,
      usage,
    });
  }

  return c.json({ limits: out });
});

// ── Credits ───────────────────────────────────────────────────────────────────
// The calling plugin's declared costs with effective prices, plus the acting
// user's balance when x-acting-user-id is sent. Read-only, for plugin UIs
// ("Creating this list costs 25 credits — you have 320").
cmsApiRoutes.get('/credits', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const payer = actingUserId(c);
  const credits = await effectiveCreditsForPlugin(c.env, auth.plugin);
  return c.json({
    balance: payer !== null ? await getCreditBalance(c.env, payer) : null,
    credits: credits.map((credit) => ({
      key: credit.def.key,
      label: credit.def.label,
      description: credit.def.description,
      charge: credit.def.charge,
      page_type: credit.def.pageType,
      unit: credit.def.unit,
      value: credit.value,
      configured: credit.configured,
    })),
  });
});

// Affordability pre-check for a declared cost — lets a plugin verify a long
// job (an EDM blast, a big import) fits the balance BEFORE starting it.
// Nothing is deducted here.
cmsApiRoutes.get('/credits/quote', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const key = (c.req.query('key') ?? '').trim();
  const quantity = Math.trunc(asFiniteNumber(c.req.query('quantity')) ?? 1);
  if (!key) return c.json({ error: 'key_required' }, 400);
  if (quantity < 1 || quantity > 1_000_000) return c.json({ error: 'invalid_quantity' }, 400);

  const credit = (await effectiveCreditsForPlugin(c.env, auth.plugin)).find((entry) => entry.def.key === key);
  if (!credit) return c.json({ error: 'unknown_credit_key' }, 400);

  const payer = actingUserId(c);
  const balance = payer !== null ? await getCreditBalance(c.env, payer) : null;
  const total = credit.value * quantity;
  return c.json({
    key,
    unit_cost: credit.value,
    quantity,
    total,
    balance,
    affordable: total === 0 || (balance !== null && balance >= total),
  });
});

// Plugin-reported usage for metered costs the host can't observe (e.g. one
// EDM send per recipient). Only keys the calling plugin's manifest declares
// as metered are accepted — a plugin cannot invent ad-hoc charges — and the
// price still comes from the host-side configuration, never the request.
cmsApiRoutes.post('/credits/charge', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    key?: unknown; quantity?: unknown; entity_type?: unknown; entity_id?: unknown; note?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return c.json({ error: 'key_required' }, 400);
  const quantity = Math.trunc(asFiniteNumber(body.quantity) ?? 1);
  if (quantity < 1 || quantity > 1_000_000) return c.json({ error: 'invalid_quantity' }, 400);

  const credit = (await effectiveCreditsForPlugin(c.env, auth.plugin)).find((entry) => entry.def.key === key);
  if (!credit) return c.json({ error: 'unknown_credit_key' }, 400);
  if (credit.def.charge !== 'metered') return c.json({ error: 'not_metered' }, 400);

  const payer = actingUserId(c);
  if (payer === null) return c.json({ error: 'acting_user_required' }, 400);

  const total = credit.value * quantity;
  if (total === 0) {
    return c.json({ ok: true, charged: 0, balance: await getCreditBalance(c.env, payer) });
  }

  const charge = await chargeCredits(c.env, {
    userId: payer,
    amount: total,
    action: `${auth.pluginId}:${key}`,
    entityType: typeof body.entity_type === 'string' ? body.entity_type.slice(0, 60) : undefined,
    entityId: typeof body.entity_id === 'string' || typeof body.entity_id === 'number' ? String(body.entity_id).slice(0, 60) : undefined,
    note: typeof body.note === 'string' ? body.note.slice(0, 300) : undefined,
    pluginId: auth.pluginId,
    createdBy: `plugin:${auth.pluginId}`,
  });
  if (!charge.ok) {
    if (charge.error === 'unknown_user') return c.json({ error: 'unknown_acting_user' }, 400);
    return c.json(
      { error: 'insufficient_credits', credit: { required: charge.required, balance: charge.balance } },
      402,
    );
  }
  return c.json({ ok: true, charged: total, balance: charge.balanceAfter });
});

// List pages of a content type the plugin owns.
cmsApiRoutes.get('/pages', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const pageType = (c.req.query('page_type') ?? '').trim();
  if (!pageType) return c.json({ error: 'page_type_required' }, 400);
  if (!pageTypeScopeAllows(auth.readableTypes, pageType)) return c.json({ error: 'forbidden_page_type' }, 403);

  const limit = Math.min(Math.max(asFiniteNumber(c.req.query('limit')) ?? 50, 1), 500);
  const offset = Math.max(asFiniteNumber(c.req.query('offset')) ?? 0, 0);
  const q = (c.req.query('q') ?? '').trim();
  // Optional parent filter: e.g. all `guest` pages belonging to one event.
  const parentId = asFiniteNumber(c.req.query('page_id'));

  // Optional pointer filter: pointer_key=mail_list&pointer_value=123
  // or pointer_key=mail_list&pointer_values=123,456.
  const pointerKey = (c.req.query('pointer_key') ?? '').trim();
  const pointerValue = (c.req.query('pointer_value') ?? '').trim();
  const pointerValuesParam = (c.req.query('pointer_values') ?? '').trim();
  const pointerValues = [
    ...(pointerValue ? [pointerValue] : []),
    ...pointerValuesParam.split(',').map((value) => value.trim()).filter(Boolean),
  ].filter((value, index, values) => values.indexOf(value) === index);
  if ((pointerKey && pointerValues.length === 0) || (!pointerKey && pointerValues.length > 0)) {
    return c.json({ error: 'pointer_key_and_value_required_together' }, 400);
  }
  if (pointerKey && !/^[a-z0-9_-]+$/i.test(pointerKey)) {
    return c.json({ error: 'invalid_pointer_key' }, 400);
  }
  if (pointerValues.length > 500) {
    return c.json({ error: 'too_many_pointer_values' }, 400);
  }

  const params: unknown[] = [pageType];
  let where = 'WHERE page_type = ?';
  if (parentId !== null) {
    where += ' AND page_id = ?';
    params.push(parentId);
  }
  if (pointerKey && pointerValues.length > 0) {
    if (pointerValues.length === 1) {
      where += ' AND json_extract(lect, ?) = ?';
    } else {
      where += ` AND json_extract(lect, ?) IN (${pointerValues.map(() => '?').join(',')})`;
    }
    params.push(`$._pointers.${pointerKey}`, ...pointerValues);
  }
  if (q) {
    const terms = chineseSearchVariants(q).map((variant) => `%${variant.replaceAll(' ', '%')}%`);
    where += ` AND (${terms.map(() => '(name LIKE ? OR slug LIKE ? OR lect LIKE ?)').join(' OR ')})`;
    for (const term of terms) params.push(term, term, term);
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
  if (!pageTypeScopeAllows(auth.readableTypes, page.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

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
  if (!result.ok) {
    return c.json(
      { error: result.error, violation: result.violation, credit: result.credit },
      result.status as 400 | 402 | 403 | 409 | 500,
    );
  }
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

  const config = await resolveCmsConfig(c.env);
  const prepared: PreparedCreate[] = [];
  const created: ApiPage[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  for (let i = 0; i < items.length; i++) {
    const result = prepareCreateInput(c, auth, config, (items[i] ?? {}) as PageInput);
    if (result.ok) prepared.push(result.input);
    else errors.push({ index: i, error: result.error });
  }

  if (prepared.length) {
    // Reject the whole batch on any quota violation, so a bulk import never
    // half-applies against a limit.
    const violation = await checkCreateLimits(
      c.env,
      prepared.map((item) => createCandidate(item.pageType, item.parentId, item.lect)),
    );
    if (violation) return c.json({ error: 'limit_exceeded', violation }, 409);

    // Total page-create cost across the batch, charged once up front —
    // all-or-nothing like the limit check, so an import either fully fits the
    // payer's balance or writes nothing.
    const typeCounts = new Map<string, number>();
    for (const item of prepared) typeCounts.set(item.pageType, (typeCounts.get(item.pageType) ?? 0) + 1);
    let totalCost = 0;
    const breakdown: Record<string, number> = {};
    for (const [type, count] of typeCounts) {
      const cost = await pageCreateCostForType(c.env, type);
      if (cost.total > 0) {
        totalCost += cost.total * count;
        breakdown[type] = cost.total * count;
      }
    }
    const payer = actingUserId(c);
    let charged = 0;
    if (totalCost > 0 && payer !== null) {
      const charge = await chargeCredits(c.env, {
        userId: payer,
        amount: totalCost,
        action: 'page_create:batch',
        pluginId: auth.pluginId,
        note: JSON.stringify(breakdown),
        createdBy: `plugin:${auth.pluginId}`,
      });
      if (!charge.ok) {
        if (charge.error === 'unknown_user') return c.json({ error: 'unknown_acting_user' }, 400);
        return c.json(
          { error: 'insufficient_credits', credit: { required: charge.required, balance: charge.balance } },
          402,
        );
      }
      charged = totalCost;
    }

    const usedSlugs = await existingSlugSet(c.env.DB, prepared.map((item) => item.baseSlug));
    const usedIds = new Set<number>();
    const statements: D1PreparedStatement[] = [];
    const hookPages: HookPage[] = [];
    const createdAt = cmsTimestamp();

    for (const item of prepared) {
      const id = item.id ?? cmsId(usedIds);
      usedIds.add(id);
      const uuid = crypto.randomUUID();
      const versionId = cmsId(usedIds);
      const slug = allocateSlug(item.baseSlug, usedSlugs);

      statements.push(...bulkPageInsertStatements(c.env.DB, {
        id, uuid, createdAt, name: item.name, slug, weight: item.weight, start: item.start,
        end: item.end, timezone: item.timezone, pageType: item.pageType, versionId,
        lect: item.lect, parentId: item.parentId,
      }));
      for (const tagId of item.tags) {
        statements.push(c.env.DB.prepare('INSERT OR IGNORE INTO draft_page_tags (page_id, tag_id) VALUES (?, ?)')
          .bind(id, tagId));
      }

      const page = {
        id,
        uuid,
        page_type: item.pageType,
        name: item.name,
        slug,
        weight: item.weight,
        start: item.start,
        end: item.end,
        timezone: item.timezone,
        page_id: item.parentId,
        created_at: createdAt,
        updated_at: createdAt,
        lect: safeParseLect(item.lect),
      };
      created.push(page);
      hookPages.push({ id, uuid, page_type: item.pageType, name: item.name, slug });
    }

    try {
      await c.env.DB.batch(statements);
    } catch (error) {
      if (charged && payer !== null) {
        await refundCredits(c.env, { userId: payer, amount: charged, action: 'page_create:batch', pluginId: auth.pluginId, createdBy: `plugin:${auth.pluginId}` });
      }
      throw error;
    }
    emitPluginHooks(c, 'create', hookPages, auth.pluginId);
  }

  return c.json({ created, errors, count: created.length });
});

// Server-side bulk clone of a parent's child pages.
//
// Built for "duplicate a guest list / event with all its guests" without the
// plugin streaming every child page out and back: the clone reads the source
// rows here (where D1 is local) and writes copies in the same Worker, applying
// one uniform lect transform — drop occurrence-specific blocks, then merge
// overrides (e.g. reset `status`, repoint `_pointers` at the new event/list).
//
// To bound work per request (and stay within the plugin's free-plan subrequest
// cap) it processes at most DUPLICATE_MAX_PER_CALL children, in DB.batch chunks,
// and returns `next_cursor` (the last source id copied) when more remain. The
// caller re-POSTs with that cursor until `done` — so an arbitrarily large list
// duplicates across several bounded requests instead of one that times out.
cmsApiRoutes.post('/pages/duplicate', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as DuplicateInput | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const pageType = typeof body.source_page_type === 'string' ? body.source_page_type.trim() : '';
  if (!pageType) return c.json({ error: 'source_page_type_required' }, 400);
  // Cloning creates pages of this type, so it needs write scope, not just read.
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return c.json({ error: 'forbidden_page_type' }, 403);

  // Select the source pages by lect pointer (how guests etc. group) or parent id.
  const selector = collectionWhere(
    asFiniteNumber(body.source_page_id),
    typeof body.source_pointer_key === 'string' ? body.source_pointer_key.trim() : '',
    typeof body.source_pointer_value === 'string' ? body.source_pointer_value : '',
  );
  if (!selector.ok) return c.json({ error: selector.error }, 400);

  const targetParentId = asFiniteNumber(body.target_page_id);
  const overrideLect = coerceLect(body.lect);
  const dropKeys = Array.isArray(body.drop_lect)
    ? body.drop_lect.filter((key): key is string => typeof key === 'string')
    : [];

  const config = await resolveCmsConfig(c.env);
  const seed = blueprintToLect(pageType, config.blueprint, config.defaultLanguage);
  const usedIds = new Set<number>();

  let cursor = Math.max(asFiniteNumber(body.cursor) ?? 0, 0);

  // Quota pre-check for everything this request could still clone. All clones
  // share the target parent and any pointer overrides, so one candidate shape
  // covers the set. Per-pointer limits are only checkable when the override
  // lect repoints the pointer (the normal "duplicate into a new list" flow);
  // clones that inherit per-row source pointers are not gated here.
  const remainingRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total FROM draft_pages WHERE ${selector.sql} AND page_type = ? AND id > ?`,
  ).bind(...selector.params, pageType, cursor).first<{ total: number }>();
  const remaining = Math.min(remainingRow?.total ?? 0, DUPLICATE_MAX_PER_CALL);
  if (remaining > 0) {
    const candidate = createCandidate(pageType, targetParentId, overrideLect);
    const violation = await checkCreateLimits(c.env, Array.from({ length: remaining }, () => candidate));
    if (violation) return c.json({ error: 'limit_exceeded', violation }, 409);
  }

  // Charge for every clone this call will make; if the loop clones fewer
  // (failure mid-way, or sources trashed concurrently) the difference is
  // refunded below.
  const cloneCost = await pageCreateCostForType(c.env, pageType);
  const payer = actingUserId(c);
  const cloneAction = pageCreateAction(pageType, cloneCost);
  let chargedClones = 0;
  if (remaining > 0 && cloneCost.total > 0 && payer !== null) {
    const charge = await chargeCredits(c.env, {
      userId: payer,
      amount: cloneCost.total * remaining,
      action: cloneAction,
      entityType: pageType,
      pluginId: auth.pluginId,
      note: `duplicate x${remaining}`,
      createdBy: `plugin:${auth.pluginId}`,
    });
    if (!charge.ok) {
      if (charge.error === 'unknown_user') return c.json({ error: 'unknown_acting_user' }, 400);
      return c.json(
        { error: 'insufficient_credits', credit: { required: charge.required, balance: charge.balance } },
        402,
      );
    }
    chargedClones = remaining;
  }
  let copied = 0;
  let done = false;
  try {
  // Loop internally in DB.batch chunks up to the per-request cap. Each chunk
  // commits on its own, so a copied row is never lost if a later chunk fails.
  while (copied < DUPLICATE_MAX_PER_CALL) {
    const take = Math.min(DUPLICATE_BATCH, DUPLICATE_MAX_PER_CALL - copied);
    // Fetch one row past the chunk to detect whether more sources remain.
    const sources = await c.env.DB.prepare(
      `SELECT * FROM draft_pages WHERE ${selector.sql} AND page_type = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    ).bind(...selector.params, pageType, cursor, take + 1).all<Page>();

    const rows = sources.results;
    if (!rows.length) { done = true; break; }
    const hasMore = rows.length > take;
    const chunk = hasMore ? rows.slice(0, take) : rows;

    const usedSlugs = await existingSlugSet(c.env.DB, chunk.map((row) => slugify(row.name) || pageType));
    const statements: D1PreparedStatement[] = [];
    const hookPages: HookPage[] = [];
    const createdAt = cmsTimestamp();

    for (const row of chunk) {
      // Mirror createPage's lect pipeline, sourced from the existing page:
      // blueprint seed ← (source lect minus dropped keys) ← overrides.
      const source = safeParseLect(row.lect);
      for (const key of dropKeys) delete (source as Record<string, unknown>)[key];
      const merged = withDraftMetadata(mergeLects(seed, mergeLects(source, overrideLect)), 0);
      const lect = stringifyLect(merged);

      const id = cmsId(usedIds);
      const uuid = crypto.randomUUID();
      const slug = allocateSlug(slugify(row.name) || pageType, usedSlugs);

      statements.push(...bulkPageInsertStatements(c.env.DB, {
        id, uuid, createdAt, name: row.name, slug, weight: row.weight ?? 5, start: row.start,
        end: row.end, timezone: row.timezone, pageType, versionId: cmsId(usedIds),
        lect, parentId: targetParentId,
      }));

      hookPages.push({ id, uuid, page_type: pageType, name: row.name, slug });
    }

    await c.env.DB.batch(statements);
    emitPluginHooks(c, 'create', hookPages, auth.pluginId);

    copied += chunk.length;
    cursor = chunk[chunk.length - 1].id;
    if (!hasMore) { done = true; break; }
  }
  } catch (error) {
    if (chargedClones > copied && payer !== null) {
      await refundCredits(c.env, {
        userId: payer,
        amount: cloneCost.total * (chargedClones - copied),
        action: cloneAction,
        pluginId: auth.pluginId,
        createdBy: `plugin:${auth.pluginId}`,
      });
    }
    throw error;
  }

  // Sources trashed concurrently → fewer clones than were charged for.
  if (chargedClones > copied && payer !== null) {
    await refundCredits(c.env, {
      userId: payer,
      amount: cloneCost.total * (chargedClones - copied),
      action: cloneAction,
      pluginId: auth.pluginId,
      createdBy: `plugin:${auth.pluginId}`,
    });
  }

  return c.json({ count: copied, next_cursor: done ? null : cursor, done });
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
  if (!pageTypeScopeAllows(auth.allowedTypes, page.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

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
  const timezone = 'timezone' in body ? (typeof body.timezone === 'string' ? body.timezone : null) : page.timezone;
  const parentId = 'page_id' in body ? asFiniteNumber(body.page_id) : page.page_id;

  await c.env.DB.prepare(
    'UPDATE draft_pages SET name=?, slug=?, weight=?, start=?, end=?, timezone=?, lect=?, page_id=? WHERE id=?',
  )
    .bind(name, slug, weight, start, end, timezone, lectVal, parentId, id)
    .run();

  await savePageVersionAndSetCurrent(c.env.DB, id, lectVal, 'update');
  if ('tags' in body) await setDraftPageTags(c.env.DB, id, body.tags, true);

  await notifyPageSaved(c.env, id);

  const updated = await c.env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?').bind(id).first<Page>();
  emitPluginHook(c, 'update', { id, uuid: page.uuid, page_type: pageType, name, slug }, auth.pluginId);
  return c.json({ page: serializePage(updated!) });
}

// Batch soft-delete pages to trash. Accepts { ids: number[] } (up to MAX_BATCH).
// Pages not found are silently skipped. Returns the count actually trashed.
// Must be registered BEFORE DELETE /pages/:id so "batch" isn't matched as an id.
cmsApiRoutes.delete('/pages/batch', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as { ids?: unknown } | null;
  const rawIds = body && Array.isArray(body.ids) ? body.ids : null;
  if (!rawIds) return c.json({ error: 'invalid_body' }, 400);

  const ids = rawIds.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
  if (!ids.length) return c.json({ ok: true, trashed: 0 });
  if (ids.length > MAX_BATCH) return c.json({ error: 'batch_too_large', max: MAX_BATCH }, 413);

  // Enforce scope: all requested ids must be allowed page types.
  const ph = ids.map(() => '?').join(',');
  const { results: types } = await c.env.DB.prepare(
    `SELECT id, page_type FROM draft_pages WHERE id IN (${ph})`,
  ).bind(...ids).all<{ id: number; page_type: string | null }>();

  for (const row of types) {
    if (!pageTypeScopeAllows(auth.allowedTypes, row.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);
  }

  const pages = await trashDraftPages(c.env.DB, ids);

  await Promise.allSettled(pages.map((page) => unpublishPageFromTargets(c.env, page.uuid)));
  for (const page of pages) {
    emitPluginHook(
      c,
      'delete',
      { id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug },
      auth.pluginId,
    );
  }

  return c.json({ ok: true, trashed: pages.length });
});

// Server-side bulk soft-delete of a related collection of pages.
//
// Counterpart to POST /pages/duplicate, for "delete an event with all its
// guests" without the plugin first reading every child id and then deleting it
// in ≤MAX_BATCH chunks. The host finds the pages itself — by lect pointer (how
// guests group: `_pointers.mail_list`) or by parent page id — and trashes them
// in DB.batch chunks; trashDraftPages copies any number of rows to trash in a
// single batch, so each chunk is a couple of subrequests regardless of size.
//
// Bounded to DELETE_CHILDREN_MAX_PER_CALL per request: since trashed rows leave
// draft_pages, a follow-up call simply picks up whatever remains, so the caller
// repeats while `done` is false. Registered BEFORE DELETE /pages/:id so
// "children" is not matched as an id.
//
// Unlike DELETE /pages/:id and /pages/batch this does NOT unpublish each child
// from publish targets — that per-page work is what makes a bulk delete slow,
// and child collections this targets (e.g. event guests) are not published.
cmsApiRoutes.delete('/pages/children', async (c) => {
  const auth = await authenticatePlugin(c);
  if (auth instanceof Response) return auth;

  const body = await c.req.json().catch(() => null) as {
    parent_page_id?: unknown; pointer_key?: unknown; pointer_value?: unknown; page_type?: unknown;
  } | null;
  if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body' }, 400);

  const pageType = typeof body.page_type === 'string' ? body.page_type.trim() : '';
  if (!pageType) return c.json({ error: 'page_type_required' }, 400);
  if (!pageTypeScopeAllows(auth.allowedTypes, pageType)) return c.json({ error: 'forbidden_page_type' }, 403);

  // Select the pages by lect pointer (how guests group) or parent page id.
  const selector = collectionWhere(
    asFiniteNumber(body.parent_page_id),
    typeof body.pointer_key === 'string' ? body.pointer_key.trim() : '',
    typeof body.pointer_value === 'string' ? body.pointer_value : '',
  );
  if (!selector.ok) return c.json({ error: selector.error }, 400);

  let trashed = 0;
  let done = false;
  const hookPages: HookPage[] = [];
  while (trashed < DELETE_CHILDREN_MAX_PER_CALL) {
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM draft_pages WHERE ${selector.sql} AND page_type = ? ORDER BY id ASC LIMIT ?`,
    ).bind(...selector.params, pageType, DELETE_CHILDREN_BATCH).all<{ id: number }>();

    if (!results.length) { done = true; break; }
    const pages = await trashDraftPages(c.env.DB, results.map((row) => row.id));
    for (const page of pages) {
      hookPages.push({ id: page.id, uuid: page.uuid, page_type: page.page_type, name: page.name, slug: page.slug });
    }
    trashed += results.length;
    if (results.length < DELETE_CHILDREN_BATCH) { done = true; break; }
  }

  // Audit + delete hooks run detached (waitUntil), so they never block the
  // response — the same best-effort path the per-id batch delete uses.
  emitPluginHooks(c, 'delete', hookPages, auth.pluginId);

  return c.json({ trashed, done });
});

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
  if (!pageTypeScopeAllows(auth.allowedTypes, existing.page_type ?? '')) return c.json({ error: 'forbidden_page_type' }, 403);

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
