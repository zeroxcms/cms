// Advanced search pages and bulk actions. (CSV export moved to the
// import-export plugin; renderAdvancedSearch links there when it's installed.)

import { Hono } from 'hono';
import { requirePermission } from '../../middleware/auth';
import { resolveCmsConfig } from '../../plugins/config';
import type { Env, Permission, Variables } from '../../types';
import {
  cmsAdminJobMessage,
  createAdvancedSearchBulkActionJob,
  type AdvancedSearchBulkAction,
} from '../../utils/admin-jobs';
import { runCmsAdminJob } from '../../utils/admin-job-runner';
import { renderAdvancedSearch, userCan } from '../../utils/admin-render';
import type { AppContext } from '../../utils/context';
import { appendQuery, dashboardStatusFilter, safeAdminReturnPath, str } from '../../utils/forms';
import {
  advancedSearchOperator,
  advancedSearchSelectedPageType,
  advancedSearchTargetPageTypes,
  parseAdvancedSearchCriteria,
} from '../../utils/search';

export const searchRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

searchRoutes.get('/advanced-search', requirePermission('content:read'), (c) => renderAdvancedSearch(c));

searchRoutes.post('/advanced-search/bulk', (c) => bulkAdvancedSearch(c));

searchRoutes.get('/advanced-search/:pageType', requirePermission('content:read'), (c) => {
  const pageType = c.req.param('pageType');
  return renderAdvancedSearch(c, pageType, false);
});

searchRoutes.post('/advanced-search/:pageType/bulk', (c) => {
  const pageType = c.req.param('pageType');
  return bulkAdvancedSearch(c, pageType, false);
});

type FormDataEntryValue = string | File;

const BULK_ACTIONS: Record<AdvancedSearchBulkAction, { permission: Permission; queued: string }> = {
  publish: { permission: 'content:publish', queued: 'Bulk publish queued. It may take a moment to finish.' },
  unpublish: { permission: 'content:publish', queued: 'Bulk unpublish queued. It may take a moment to finish.' },
  delete: { permission: 'content:delete', queued: 'Bulk deletion queued. It may take a moment to finish.' },
};

function bulkAction(value: FormDataEntryValue | null): AdvancedSearchBulkAction | null {
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

  const scope = str(form.get('scope')) === 'all' ? 'all' : 'selected';
  const ids = uniquePageIds(form.getAll('page_ids'));
  let pageTypes: string[] = [];
  const criteria = parseAdvancedSearchCriteria(c.req.url);
  const operator = advancedSearchOperator(c.req.query('operator'));
  const isDashboardBulk = c.req.query('dashboard') === '1';
  const status = isDashboardBulk
    ? dashboardStatusFilter(c.req.query('status')) || undefined
    : undefined;

  if (scope === 'all') {
    if (isDashboardBulk) {
      if (defaultPageType !== 'all') {
        // Page-list routes may contain stored page types that are no longer in
        // the active blueprint. Keep the bulk scope on that exact list.
        pageTypes = [defaultPageType];
      } else {
        const rows = await c.env.DB.prepare(
          "SELECT DISTINCT page_type FROM draft_pages WHERE page_type IS NOT NULL AND page_type != ''",
        ).all<{ page_type: string }>();
        pageTypes = rows.results.map((row) => row.page_type);
      }
    } else {
      const config = await resolveCmsConfig(c.env);
      const selectedPageType = canSelectPageType
        ? advancedSearchSelectedPageType(c.req.query('page_type'), defaultPageType, config)
        : advancedSearchSelectedPageType(undefined, defaultPageType, config);
      pageTypes = advancedSearchTargetPageTypes(selectedPageType, config);
    }
  }

  if (scope === 'selected' && !ids.length) {
    return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent('No matching pages')}`));
  }

  const job = await createAdvancedSearchBulkActionJob(c.env.DB, {
    action,
    scope,
    ids: scope === 'all' ? [] : ids,
    pageTypes,
    criteria,
    operator,
    status,
    returnTo,
    user: c.get('user'),
  });

  if (c.env.ADMIN_JOBS_QUEUE) {
    await c.env.ADMIN_JOBS_QUEUE.send(cmsAdminJobMessage(job.id));
  } else {
    c.executionCtx.waitUntil(runCmsAdminJob(c.env, job.id));
  }

  return c.redirect(appendQuery(returnTo, `flash=${encodeURIComponent(BULK_ACTIONS[action].queued)}`));
}
