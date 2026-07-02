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
import type { Env, Permission, Variables } from '../../types';
import { pluginById, PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../../plugins/registry';
import type { AppContext } from '../../utils/context';
import { effectivePermissions, resolveRolePermissions, splitRoles } from '../../utils/roles';
import { jsonError, wantsJsonResponse } from '../../middleware/auth';
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
import { computeIntegrity, getAssetApproval, listApprovals } from '../../utils/plugin-assets';
import type { ApprovedPluginAssets } from '../../templates/layout';

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// No blanket role gate here — see userCanAccessPlugin() below, applied inside
// proxyToPlugin once the plugin's manifest (and its declared permissions) is
// resolved.
// Registered before the generic catch-all so approved-asset requests don't
// fall through to the plugin admin proxy.
pluginAdminRoutes.get('/plugins/:pluginId/assets/*', (c) => servePluginAsset(c));
pluginAdminRoutes.all('/plugins/:pluginId', (c) => proxyToPlugin(c));
pluginAdminRoutes.all('/plugins/:pluginId/*', (c) => proxyToPlugin(c));

/**
 * Plugin admin pages render in the CMS origin (see proxyToPlugin), so a hostile
 * or compromised plugin would run with the CMS's same-origin authority. Until
 * plugins are served from a dedicated origin, only 'admin' passes by default —
 * unless the plugin manifest opts in by declaring its own permissions (see
 * PluginManifest.permissions), in which case a user holding any one of those
 * granted permissions is trusted to reach that specific plugin's admin routes
 * too. Plugins that declare no permissions stay admin-only (fail closed).
 */
async function hasDeclaredPluginPermission(c: AppContext, manifestPermissions: Array<{ value: string }>): Promise<boolean> {
  if (manifestPermissions.length === 0) return false;
  const map = await resolveRolePermissions(c.env);
  const granted = effectivePermissions(map, c.get('user').role);
  return manifestPermissions.some(({ value }) => granted.has(value as Permission));
}

function adminOnlyForbidden(c: AppContext): Response {
  if (wantsJsonResponse(c.req.raw)) {
    return jsonError({ success: false, error: 'Admin role required' }, 403, 'admin-role-required');
  }
  return c.text('Forbidden: admin role required', 403);
}

/**
 * Serves a single admin-approved plugin asset (JS/CSS) at a CMS-origin URL, so
 * chrome-wrapped plugin templates can reference it as a same-origin
 * <script src>/<link href> under the strict CSP (script-src 'self'). Bytes are
 * re-fetched from the plugin and re-hashed on every request — if they no
 * longer match the pinned approval, this fails closed rather than serving
 * content an admin never reviewed. See utils/plugin-assets.ts.
 */
async function servePluginAsset(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const isAdmin = splitRoles(c.get('user').role).includes('admin');
  const plugin = await pluginById(c.env, pluginId);
  if (!isAdmin && !(plugin && await hasDeclaredPluginPermission(c, plugin.manifest.permissions ?? []))) {
    return adminOnlyForbidden(c);
  }
  if (!plugin) return c.notFound();

  const url = new URL(c.req.url);
  // The Hono route is `/plugins/:pluginId/assets/*` (a fixed "assets" segment
  // plus a wildcard), but manifest asset paths already start with "/assets/..."
  // themselves — so the CMS-side URL is prefix-only (no extra "/assets") and
  // the remainder reconstructs the manifest path exactly, e.g.
  // "/admin/plugins/checkin/assets/js/kiosk.js" -> "/assets/js/kiosk.js".
  const prefix = `/admin/plugins/${pluginId}`;
  const assetPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!assetPath.startsWith('/') || assetPath.includes('..')) return c.notFound();

  const approval = await getAssetApproval(c.env.DB, pluginId, assetPath);
  if (!approval) return c.text('Not found: asset not approved', 404);

  const upstream = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${assetPath}`);
  if (!upstream.ok) return c.text('Asset unavailable', 502);
  const bytes = await upstream.arrayBuffer();
  const integrity = await computeIntegrity(bytes);
  if (integrity !== approval.integrity) {
    // The plugin's file changed since approval — do not serve unreviewed bytes.
    return c.text('Asset changed since approval; re-approval required', 409);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': assetPath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
      // Integrity is re-checked on every request rather than relying on a cache
      // to stay in sync with the approval, so this endpoint stays uncached.
      'cache-control': 'no-store',
    },
  });
}

/** Admin-approved assets for a plugin, restricted to paths it currently
 *  declares in its manifest (an approval for a path the plugin no longer
 *  lists is dormant, not revived, until re-declared and re-approved). */
async function approvedAssetsFor(c: AppContext, pluginId: string, declaredPaths: Set<string>): Promise<ApprovedPluginAssets> {
  if (declaredPaths.size === 0) return {};
  const approvals = await listApprovals(c.env.DB, pluginId);
  const entries = approvals
    .filter((approval) => declaredPaths.has(approval.path))
    .map((approval) => ({ path: approval.path, integrity: approval.integrity }));
  return entries.length ? { [pluginId]: entries } : {};
}

async function proxyToPlugin(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();

  const isAdmin = splitRoles(c.get('user').role).includes('admin');
  const plugin = await pluginById(c.env, pluginId);

  // Non-admins are rejected the same way whether the plugin is unregistered or
  // just doesn't grant them access — matching the prior route-level gate, which
  // never resolved the plugin at all for a non-admin.
  if (!isAdmin && !(plugin && await hasDeclaredPluginPermission(c, plugin.manifest.permissions ?? []))) {
    return adminOnlyForbidden(c);
  }

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
    const declaredAssetPaths = new Set((plugin.manifest.assets ?? []).map((asset) => asset.path));
    const approvedPluginAssets = await approvedAssetsFor(c, pluginId, declaredAssetPaths);
    const wrapped = await adminLayout(viewsFor(c.env), base, { title, body, approvedPluginAssets });
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
