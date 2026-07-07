import { deliverHook, type HookEvent, type HookPage } from '../plugins/hooks';
import { PLUGIN_ORIGIN, pluginById } from '../plugins/registry';
import {
  publishPageToTargets,
  unpublishPageFromTargets,
} from '../publish';
import type { Env, JWTPayload, Page } from '../types';
import { trashDraftPages } from './admin-queries';
import {
  claimAdminJob,
  completeAdminJob,
  failAdminJob,
  type AdminJobRecord,
  type AdvancedSearchBulkAction,
  type AdvancedSearchBulkActionInput,
} from './admin-jobs';
import { appendQuery } from './forms';
import { advancedSearchMatchingPageIds } from './search';

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
  headers.set('x-plugin-secret', plugin.secret);
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
  const input = parseAdvancedSearchBulkActionJob(job.body);
  const ids = input.scope === 'all'
    ? await advancedSearchMatchingPageIds(env.DB, input.pageTypes, input.criteria, input.operator)
    : input.ids;

  const outcome = await applyAdvancedSearchBulkAction(env, job.user, input.action, ids);
  await completeAdminJob(env.DB, job.id, 200, appendQuery(
    input.returnTo,
    `flash=${encodeURIComponent(bulkFlash(input.action, outcome.updated, outcome.refused, Array.from(outcome.failedTargets)))}`,
  ));
}

function parseAdvancedSearchBulkActionJob(body: string | null): Omit<AdvancedSearchBulkActionInput, 'user'> {
  const value = body ? JSON.parse(body) as Partial<AdvancedSearchBulkActionInput> : null;
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
  const returnTo = typeof value.returnTo === 'string' && value.returnTo.startsWith('/admin')
    ? value.returnTo
    : '/admin/advanced-search';
  if (scope === 'all' && !pageTypes.length) throw new Error('Admin job is missing page types');
  return { action: value.action, scope, ids, pageTypes, criteria, operator, returnTo };
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
    for (const chunk of chunks(ids)) {
      const trashed = await trashDraftPages(env.DB, chunk);
      for (const page of trashed) {
        const outcome = await unpublishPageFromTargets(env, page.uuid, page.page_type);
        if (outcome.refused) refused += 1;
        outcome.failures.forEach((target) => failedTargets.add(target));
        await emitPageLifecycle(env, user, 'delete', page);
      }
      updated += trashed.length;
    }
    return { updated, refused, failedTargets };
  }

  const pages = await draftPagesByIds(env.DB, ids);
  for (const page of pages) {
    const outcome = action === 'publish'
      ? await publishPageToTargets(env, page.id)
      : await unpublishPageFromTargets(env, page.uuid, page.page_type);
    if (!outcome) continue;
    if (outcome.refused) {
      refused += 1;
      continue;
    }
    outcome.failures.forEach((target) => failedTargets.add(target));
    await emitPageLifecycle(env, user, action, page);
    updated += 1;
  }

  return { updated, refused, failedTargets };
}

async function emitPageLifecycle(
  env: Env,
  user: JWTPayload,
  event: HookEvent,
  page: HookPage,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, detail)
     VALUES (?, ?, ?, 'page', ?, ?)`,
  ).bind(
    String(user.sub),
    user.email,
    `page.${event}`,
    String(page.id),
    JSON.stringify({ name: page.name, slug: page.slug, page_type: page.page_type }),
  ).run();
  await deliverHook(env, user, event, page);
}

async function draftPagesByIds(db: D1Database, ids: number[]): Promise<Page[]> {
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
