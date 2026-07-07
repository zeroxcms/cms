// Advanced search pages and CSV exports.

import { Hono } from 'hono';
import { dispatchHook } from '../../plugins/hooks';
import { resolveCmsConfig } from '../../plugins/config';
import {
  describeFailures,
  publishPageToTargets,
  unpublishPageFromTargets,
} from '../../publish';
import type { Env, Page, Permission, Variables } from '../../types';
import { trashDraftPages } from '../../utils/admin-queries';
import { exportAdvancedSearch, renderAdvancedSearch, userCan } from '../../utils/admin-render';
import type { AppContext } from '../../utils/context';
import { appendQuery, safeAdminReturnPath, str } from '../../utils/forms';
import {
  advancedSearchMatchingPageIds,
  advancedSearchOperator,
  advancedSearchSelectedPageType,
  advancedSearchTargetPageTypes,
  parseAdvancedSearchCriteria,
} from '../../utils/search';

export const searchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

searchRoutes.get('/advanced-search', (c) => renderAdvancedSearch(c));

searchRoutes.post('/advanced-search/bulk', (c) => bulkAdvancedSearch(c));

searchRoutes.get('/advanced-search-export', (c) => exportAdvancedSearch(c));

searchRoutes.get('/advanced-search-export/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return exportAdvancedSearch(c, pageType, false);
});

searchRoutes.get('/advanced-search/:pageType', (c) => {
  const pageType = c.req.param('pageType');
  return renderAdvancedSearch(c, pageType, false);
});

searchRoutes.post('/advanced-search/:pageType/bulk', (c) => {
  const pageType = c.req.param('pageType');
  return bulkAdvancedSearch(c, pageType, false);
});

type BulkAction = 'publish' | 'unpublish' | 'delete';
type FormDataEntryValue = string | File;

const BULK_ACTIONS: Record<BulkAction, { permission: Permission; past: string }> = {
  publish: { permission: 'content:publish', past: 'published' },
  unpublish: { permission: 'content:publish', past: 'unpublished' },
  delete: { permission: 'content:delete', past: 'moved to trash' },
};

function bulkAction(value: FormDataEntryValue | null): BulkAction | null {
  const action = str(value);
  return action === 'publish' || action === 'unpublish' || action === 'delete'
    ? action
    : null;
}

function uniquePageIds(values: FormDataEntryValue[]): number[] {
  const ids = values
    .map((value) => str(value))
    .filter((value) => /^\d+$/.test(value))
    .map((value) => parseInt(value, 10));
  return Array.from(new Set(ids));
}

function chunks<T>(values: T[], size = 90): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
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

function bulkFlash(action: BulkAction, count: number, refused = 0, failedTargets: string[] = []): string {
  const pageLabel = count === 1 ? 'page' : 'pages';
  const base = count === 0
    ? 'No pages updated'
    : `${count} ${pageLabel} ${BULK_ACTIONS[action].past}`;
  const notes: string[] = [];
  if (refused) notes.push(`${refused} submission ${refused === 1 ? 'page was' : 'pages were'} skipped`);
  if (failedTargets.length) notes.push(`target failures: ${failedTargets.join(', ')}`);
  return notes.length ? `${base}; ${notes.join('; ')}` : base;
}

async function bulkAdvancedSearch(
  c: AppContext,
  defaultPageType = 'all',
  canSelectPageType = true,
): Promise<Response> {
  const form = await c.req.formData();
  const action = bulkAction(form.get('bulk_action'));
  const returnTo = safeAdminReturnPath(form.get('return_to'), '/admin/advanced-search');
  if (!action) return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('Choose a bulk action')}`));

  if (!(await userCan(c, BULK_ACTIONS[action].permission))) {
    return c.text('Forbidden: insufficient permissions', 403);
  }

  let ids = uniquePageIds(form.getAll('page_ids'));
  if (str(form.get('scope')) === 'all') {
    const config = await resolveCmsConfig(c.env);
    const criteria = parseAdvancedSearchCriteria(c.req.url);
    const selectedPageType = canSelectPageType
      ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType, config)
      : advancedSearchSelectedPageType(undefined, defaultPageType, config);
    const pageTypes = advancedSearchTargetPageTypes(selectedPageType, config);
    const operator = advancedSearchOperator(c.req.query('operator'));
    ids = await advancedSearchMatchingPageIds(c.env.DB, pageTypes, criteria, operator);
  }

  if (!ids.length) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('No matching pages')}`));
  }

  const failedTargets = new Set<string>();
  let updated = 0;
  let refused = 0;

  if (action === 'delete') {
    for (const chunk of chunks(ids)) {
      const trashed = await trashDraftPages(c.env.DB, chunk);
      for (const page of trashed) {
        const outcome = await unpublishPageFromTargets(c.env, page.uuid, page.page_type);
        if (outcome.refused) refused += 1;
        const failed = describeFailures(outcome);
        if (failed) outcome.failures.forEach((target) => failedTargets.add(target));
        dispatchHook(c, 'delete', {
          id: page.id,
          uuid: page.uuid,
          name: page.name,
          slug: page.slug,
          page_type: page.page_type,
        });
      }
      updated += trashed.length;
    }
  } else {
    const pages = await draftPagesByIds(c.env.DB, ids);
    for (const page of pages) {
      const outcome = action === 'publish'
        ? await publishPageToTargets(c.env, page.id)
        : await unpublishPageFromTargets(c.env, page.uuid, page.page_type);
      if (!outcome) continue;
      if (outcome.refused) {
        refused += 1;
        continue;
      }
      const failed = describeFailures(outcome);
      if (failed) outcome.failures.forEach((target) => failedTargets.add(target));
      dispatchHook(c, action, {
        id: page.id,
        uuid: page.uuid,
        name: page.name,
        slug: page.slug,
        page_type: page.page_type,
      });
      updated += 1;
    }
  }

  return c.redirect(appendQuery(
    returnTo,
    `flash=${encodeURIComponent(bulkFlash(action, updated, refused, Array.from(failedTargets)))}`,
  ));
}
