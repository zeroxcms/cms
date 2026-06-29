// ============================================================
// Plugin admin proxy — forwards /admin/plugins/<id>/* to the
// plugin Worker's /__plugin/admin/* handler.
//
// Mounted under the authenticated, editor-guarded admin router, so
// the signed-in user is already verified. We forward a trusted
// user summary + the shared PLUGIN_SECRET, and strip CMS cookies
// so the plugin never sees CMS session credentials.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { pluginById, PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../../plugins/registry';
import type { AppContext } from '../../utils/context';
import { requireAdmin } from '../../middleware/auth';
import { adminLayout } from '../../templates/layout';
import { pluginClientView } from '../../templates/liquid';
import { buildBaseProps } from '../../utils/admin-render';
import { viewsFor } from '../../plugins/views';
import {
  buildPluginProxyHeaders,
  decodePluginTitle,
  readPluginClientViewData,
  pluginDocumentResponse,
  warnSharedPluginOrigin,
  wantsCmsChrome,
} from '../../security/plugin-proxy';
import { sanitizePluginHtmlFragment } from '../../security/plugin-sanitize';
import { cmsAdminJobMessage, createPluginAdminActionJob } from '../../utils/admin-jobs';

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Plugin admin pages render in the CMS origin (see proxyToPlugin), so a hostile
// or compromised plugin would run with the CMS's same-origin authority. Until
// plugins are served from a dedicated origin, restrict access to admins only to
// minimize who can be exposed to that risk.
pluginAdminRoutes.use('/plugins/:pluginId', requireAdmin);
pluginAdminRoutes.use('/plugins/:pluginId/*', requireAdmin);

pluginAdminRoutes.all('/plugins/:pluginId', (c) => proxyToPlugin(c));
pluginAdminRoutes.all('/plugins/:pluginId/*', (c) => proxyToPlugin(c));

async function proxyToPlugin(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const plugin = await pluginById(c.env, pluginId);
  if (!plugin) return c.notFound();

  // Each plugin authenticates with its own secret (or the env fallback). Fail
  // closed when neither is configured rather than proxying unauthenticated.
  if (!plugin.secret) {
    console.error(`Plugin ${pluginId} has no secret configured (and no PLUGIN_SECRET fallback)`);
    return new Response('Server misconfigured', {
      status: 500,
      headers: { 'X-CMS-Error': 'plugin-secret-required' },
    });
  }

  const url = new URL(c.req.url);
  const prefix = `/admin/plugins/${pluginId}`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const pluginAdminPath = `${PLUGIN_PREFIX}/admin${rest}${url.search}`;
  const upstream = `${PLUGIN_ORIGIN}${pluginAdminPath}`;

  const headers = buildPluginProxyHeaders(c.req.raw.headers, c.get('user'), plugin.secret);

  warnSharedPluginOrigin();

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const body = hasBody ? await c.req.raw.arrayBuffer() : undefined;
  if (shouldQueuePluginAdminAction(c, pluginId, rest) && c.env.ADMIN_JOBS_QUEUE) {
    const bodyText = body ? new TextDecoder().decode(body) : '';
    const job = await createPluginAdminActionJob(c.env.DB, {
      pluginId,
      method: c.req.method,
      path: pluginAdminPath,
      contentType: c.req.raw.headers.get('content-type'),
      body: bodyText,
      user: c.get('user'),
    });
    await c.env.ADMIN_JOBS_QUEUE.send(cmsAdminJobMessage(job.id));
    return c.redirect(queueRedirect(pluginId, rest));
  }

  const upstreamResponse = await plugin.fetcher.fetch(upstream, {
    method: c.req.method,
    headers,
    body,
    redirect: 'manual',
  });

  // Opt-in chrome: a plugin that returns an HTML *fragment* with `x-cms-chrome: 1`
  // gets wrapped in the standard admin layout — same sidebar, fonts, and
  // /assets/admin.css as every CMS page — so plugin admin UIs match the CMS
  // without each plugin reinventing the shell. The wrapped page runs under the
  // CMS's strict nonce CSP (no `unsafe-inline` scripts), which is stricter than
  // the relaxed full-document policy below. Plugins that return a full document
  // (no header) keep the legacy behavior.
  if (wantsCmsChrome(upstreamResponse)) {
    const clientView = await readPluginClientViewData(upstreamResponse.clone());
    const body = clientView
      ? pluginClientView(clientView.viewPath, clientView.data, `/admin/plugins/${pluginId}/views`)
      : await sanitizePluginHtmlFragment(await upstreamResponse.text());
    const title = decodePluginTitle(upstreamResponse.headers.get('x-cms-title')) || plugin.manifest.name || 'Plugin';
    const base = await buildBaseProps(c);
    const wrapped = await adminLayout(viewsFor(c.env), base, { title, body });
    // No explicit CSP here — the global security middleware applies the strict
    // nonce policy (matching the nonce adminLayout embeds), like any CMS page.
    return c.html(wrapped, upstreamResponse.status as 200);
  }

  // Give full-document plugin pages their own CSP so (a) the CMS's strict nonce
  // CSP isn't imposed on plugin HTML (which would break legitimate plugin
  // scripts) and (b) plugin pages still get baseline hardening. This is NOT
  // origin isolation - see warnSharedPluginOrigin() - it only limits injection
  // into an otherwise-benign plugin.
  return pluginDocumentResponse(upstreamResponse);
}

function shouldQueuePluginAdminAction(c: AppContext, pluginId: string, rest: string): boolean {
  if (c.req.method !== 'POST') return false;
  if (pluginId !== 'events') return false;
  return /^\/events\/\d+\/(?:duplicate|delete)$/.test(rest);
}

function queueRedirect(pluginId: string, rest: string): string {
  const action = rest.endsWith('/duplicate') ? 'duplication' : 'deletion';
  return withFlash(`/admin/plugins/${pluginId}/events`, `Event ${action} queued. It may take a moment to finish.`);
}

function withFlash(path: string, message: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}flash=${encodeURIComponent(message)}`;
}
