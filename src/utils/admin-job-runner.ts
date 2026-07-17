import { deliverHooks, type HookEvent, type HookPage } from '../plugins/hooks';
import { PLUGIN_ORIGIN, pluginById } from '../plugins/registry';
import { pluginTenantId, setPluginAuthHeaders } from '../security/plugin-proxy';
import {
  listLiveByTypes,
  publishPageToTargets,
  unpublishPageFromTargets,
  unpublishPagesFromTargets,
} from '../publish';
import type { Env, JWTPayload, Page } from '../types';
import { trashDraftPages, type TrashedPageRef } from './admin-queries';
import {
  claimAdminJob,
  completeAdminJob,
  failAdminJob,
  requeueAdminJob,
  type AdminJobRecord,
  type AdvancedSearchBulkAction,
  type AdvancedSearchBulkActionPayload,
} from './admin-jobs';
import { appendQuery } from './forms';
import { advancedSearchMatchingPageIds } from './search';
import { isSubmissionMirror } from './submission-ingest';

const ADVANCED_SEARCH_BULK_JOB_PAGE_LIMIT = 100;

export async function runCmsAdminJob(env: Env, jobId: string): Promise<void> {
  const job = await claimAdminJob(env.DB, jobId);
  if (!job) return;

  try {
    if (job.type === 'plugin_admin_action') {
      await runPluginAdminActionJob(env, job);
    } else if (job.type === 'advanced_search_bulk_action') {
      await runAdvancedSearchBulkActionJob(env, job);
    } else {
      throw new Error(`Unsupported admin job type ${job.type}`);
    }
  } catch (error) {
    await failAdminJob(env.DB, job.id, error);
    console.error(`[cms] admin job ${job.id} failed`, error);
  }
}

async function runPluginAdminActionJob(env: Env, job: AdminJobRecord): Promise<void> {
  if (!job.pluginId || !job.method || !job.path || !job.user) throw new Error('Admin job is missing plugin request data');

  const plugin = await pluginById(env, job.pluginId);
  if (!plugin) throw new Error(`Plugin ${job.pluginId} is not available`);
  if (!plugin.secret) throw new Error(`Plugin ${job.pluginId} has no secret configured`);

  const headers = new Headers();
  headers.set('x-cms-user', JSON.stringify({
    id: job.user.sub,
    email: job.user.email,
    name: job.user.name,
    role: job.user.role,
  }));
  setPluginAuthHeaders(headers, plugin.secret, pluginTenantId(env));
  headers.set('x-cms-background-job', '1');
  if (job.contentType) headers.set('content-type', job.contentType);

  const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${job.path}`, {
    method: job.method,
    headers,
    body: job.method === 'GET' || job.method === 'HEAD' ? undefined : job.body ?? undefined,
    redirect: 'manual',
  });

  if (response.status < 200 || response.status >= 400) {
    const text = await response.text().catch(() => '');
    throw new Error(`Plugin action returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }

  await completeAdminJob(env.DB, job.id, response.status, response.headers.get('location'));
}

async function runAdvancedSearchBulkActionJob(env: Env, job: AdminJobRecord): Promise<void> {
  if (!job.user) throw new Error('Admin job is missing user data');
  let input = parseAdvancedSearchBulkActionJob(job.body);
  if (input.scope === 'all' && !input.resolvedAll) {
    let ids = await advancedSearchMatchingPageIds(env.DB, input.pageTypes, input.criteria, input.operator);
    if (input.status) {
      const liveUuids = new Set((await listLiveByTypes(env, input.pageTypes)).map((page) => page.uuid));
      const matchingPages = await draftPagesByIds(env.DB, ids);
      ids = matchingPages
        .filter((page) => input.status === 'live' ? liveUuids.has(page.uuid) : !liveUuids.has(page.uuid))
        .map((page) => page.id);
    }
    input = {
      ...input,
      ids,
      cursor: 0,
      resolvedAll: true,
    };
  }

  const cursor = Math.max(0, input.cursor ?? 0);
  const pageIds = input.ids.slice(cursor, cursor + ADVANCED_SEARCH_BULK_JOB_PAGE_LIMIT);
  const outcome = await applyAdvancedSearchBulkAction(env, job.user, input.action, pageIds);
  const updated = (input.updated ?? 0) + outcome.updated;
  const refused = (input.refused ?? 0) + outcome.refused;
  const failedTargets = Array.from(new Set([...(input.failedTargets ?? []), ...outcome.failedTargets]));
  const nextCursor = cursor + pageIds.length;

  if (nextCursor < input.ids.length) {
    const nextInput: AdvancedSearchBulkActionPayload = {
      ...input,
      cursor: nextCursor,
      updated,
      refused,
      failedTargets,
    };
    await requeueAdminJob(env.DB, job.id, JSON.stringify(nextInput));
    if (env.ADMIN_JOBS_QUEUE) {
      await env.ADMIN_JOBS_QUEUE.send({ kind: 'cms_admin_job', jobId: job.id });
    } else {
      await runCmsAdminJob(env, job.id);
    }
    return;
  }

  await completeAdminJob(env.DB, job.id, 200, appendQuery(
    input.returnTo,
    `flash=${encodeURIComponent(bulkFlash(input.action, updated, refused, failedTargets))}`,
  ));
}

function parseAdvancedSearchBulkActionJob(body: string | null): AdvancedSearchBulkActionPayload {
  const value = body ? JSON.parse(body) as Partial<AdvancedSearchBulkActionPayload> : null;
  if (!value || typeof value !== 'object') throw new Error('Admin job is missing bulk action payload');
  if (value.action !== 'publish' && value.action !== 'unpublish' && value.action !== 'delete') {
    throw new Error('Admin job has invalid bulk action');
  }
  const scope = value.scope === 'all' ? 'all' : 'selected';
  const ids = Array.isArray(value.ids)
    ? value.ids.filter((id): id is number => typeof id === 'number' && Number.isFinite(id))
    : [];
  const pageTypes = Array.isArray(value.pageTypes)
    ? value.pageTypes.filter((pageType): pageType is string => typeof pageType === 'string' && pageType.length > 0)
    : [];
  const criteria = Array.isArray(value.criteria) ? value.criteria : [];
  const operator = value.operator === 'OR' || value.operator === 'NOT' ? value.operator : 'AND';
  const status = value.status === 'draft' || value.status === 'live' ? value.status : undefined;
  const returnTo = typeof value.returnTo === 'string' && value.returnTo.startsWith('/admin')
    ? value.returnTo
    : '/admin/advanced-search';
  const cursor = typeof value.cursor === 'number' && Number.isFinite(value.cursor) ? Math.max(0, value.cursor) : 0;
  const updated = typeof value.updated === 'number' && Number.isFinite(value.updated) ? Math.max(0, value.updated) : 0;
  const refused = typeof value.refused === 'number' && Number.isFinite(value.refused) ? Math.max(0, value.refused) : 0;
  const failedTargets = Array.isArray(value.failedTargets)
    ? value.failedTargets.filter((target): target is string => typeof target === 'string' && target.length > 0)
    : [];
  const resolvedAll = value.resolvedAll === true;
  if (scope === 'all' && !pageTypes.length) throw new Error('Admin job is missing page types');
  return { action: value.action, scope, ids, pageTypes, criteria, operator, status, returnTo, resolvedAll, cursor, updated, refused, failedTargets };
}

async function applyAdvancedSearchBulkAction(
  env: Env,
  user: JWTPayload,
  action: AdvancedSearchBulkAction,
  ids: number[],
): Promise<{ updated: number; refused: number; failedTargets: Set<string> }> {
  const failedTargets = new Set<string>();
  let updated = 0;
  let refused = 0;

  if (!ids.length) return { updated, refused, failedTargets };

  if (action === 'delete') {
    const deleted: TrashedPageRef[] = [];
    for (const chunk of chunks(ids)) {
      const trashed = await trashDraftPages(env.DB, chunk);
      if (!trashed.length) continue;
      // One bulk unpublish per chunk instead of a per-page delete: D1 collapses
      // the whole slice into a single batch, so a 90-page chunk costs ~1 round
      // trip to the published DB rather than ~3 per page.
      const outcome = await unpublishPagesFromTargets(env, trashed);
      refused += outcome.refusedCount;
      outcome.failures.forEach((target) => failedTargets.add(target));
      deleted.push(...trashed);
      updated += trashed.length;
    }
    await emitPageLifecycle(env, user, 'delete', deleted);
    return { updated, refused, failedTargets };
  }

  const pages = await draftPagesByIds(env.DB, ids);
  const succeeded: Page[] = [];
  for (const page of pages) {
    const outcome = action === 'publish'
      ? await publishPageToTargets(env, page.id)
      : await unpublishPageFromTargets(env, page.uuid, await isSubmissionMirror(env.DB, page.id));
    if (!outcome) continue;
    if (outcome.refused) {
      refused += 1;
      continue;
    }
    outcome.failures.forEach((target) => failedTargets.add(target));
    succeeded.push(page);
    updated += 1;
  }
  await emitPageLifecycle(env, user, action, succeeded);

  return { updated, refused, failedTargets };
}

// Records audit rows and fires lifecycle hooks for a whole batch of pages at
// once: one DB.batch of audit inserts instead of an INSERT per page, and hooks
// delivered in chunked bulk POSTs rather than one fetch per page. Both are
// best-effort (a failed audit or hook never fails the bulk job), mirroring the
// plugin bulk path.
async function emitPageLifecycle(
  env: Env,
  user: JWTPayload,
  event: HookEvent,
  pages: HookPage[],
): Promise<void> {
  if (!pages.length) return;
  const auditPromise = env.DB.batch(
    pages.map((page) => env.DB.prepare(
      `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, detail)
       VALUES (?, ?, ?, 'page', ?, ?)`,
    ).bind(
      String(user.sub),
      user.email,
      `page.${event}`,
      String(page.id),
      JSON.stringify({ name: page.name, slug: page.slug, page_type: page.page_type }),
    )),
  );
  const hooksPromise = deliverHooks(env, user, event, pages);
  await Promise.allSettled([auditPromise, hooksPromise]);
}

async function draftPagesByIds(db: D1DatabaseClient, ids: number[]): Promise<Page[]> {
  const pages: Page[] = [];
  for (const chunk of chunks(ids)) {
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT * FROM draft_pages WHERE id IN (${placeholders})`)
      .bind(...chunk)
      .all<Page>();
    pages.push(...rows.results);
  }
  const byId = new Map(pages.map((page) => [page.id, page]));
  return ids.map((id) => byId.get(id)).filter((page): page is Page => !!page);
}

function chunks<T>(values: T[], size = 90): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function bulkFlash(action: AdvancedSearchBulkAction, count: number, refused = 0, failedTargets: string[] = []): string {
  const past = action === 'delete' ? 'moved to trash' : `${action}ed`;
  const pageLabel = count === 1 ? 'page' : 'pages';
  const base = count === 0 ? 'No pages updated' : `${count} ${pageLabel} ${past}`;
  const notes: string[] = [];
  if (refused) notes.push(`${refused} submission ${refused === 1 ? 'page was' : 'pages were'} skipped`);
  if (failedTargets.length) notes.push(`target failures: ${failedTargets.join(', ')}`);
  return notes.length ? `${base}; ${notes.join('; ')}` : base;
}
