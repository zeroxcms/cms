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
import { requirePermission } from '../../middleware/auth';
import { adminLayout } from '../../templates/layout';
import { buildBaseProps } from '../../utils/admin-render';
import { viewsFor } from '../../plugins/views';

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Plugin admin pages render in the CMS origin (see proxyToPlugin), so a hostile
// or compromised plugin would run with the CMS's same-origin authority. Until
// plugins are served from a dedicated origin, restrict access to admins only to
// minimize who can be exposed to that risk.
pluginAdminRoutes.use('/plugins/:pluginId', requirePermission('plugin:access'));
pluginAdminRoutes.use('/plugins/:pluginId/*', requirePermission('plugin:access'));

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
  const upstream = `${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/admin${rest}${url.search}`;

  const user = c.get('user');
  // Forward an explicit allowlist of request headers. Copying everything
  // would leak CMS cookies and let clients smuggle x-plugin-secret /
  // x-cms-user values through to the plugin Worker.
  const FORWARD_HEADERS = ['accept', 'accept-language', 'content-type', 'content-length', 'user-agent', 'x-requested-with'];
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    'x-cms-user',
    JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  );
  headers.set('x-plugin-secret', plugin.secret);

  warnSharedOrigin();

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  const upstreamResponse = await plugin.fetcher.fetch(upstream, {
    method: c.req.method,
    headers,
    body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
  });

  // Opt-in chrome: a plugin that returns an HTML *fragment* with `x-cms-chrome: 1`
  // gets wrapped in the standard admin layout — same sidebar, fonts, and
  // /assets/admin.css as every CMS page — so plugin admin UIs match the CMS
  // without each plugin reinventing the shell. The wrapped page runs under the
  // CMS's strict nonce CSP (no `unsafe-inline` scripts), which is stricter than
  // the relaxed full-document policy below. Plugins that return a full document
  // (no header) keep the legacy behavior.
  const wantsChrome = upstreamResponse.headers.get('x-cms-chrome') === '1'
    && (upstreamResponse.headers.get('content-type') ?? '').includes('text/html');
  if (wantsChrome) {
    const fragment = await upstreamResponse.text();
    const title = decodeTitle(upstreamResponse.headers.get('x-cms-title')) || plugin.manifest.name || 'Plugin';
    const base = await buildBaseProps(c);
    const wrapped = await adminLayout(viewsFor(c.env), base, { title, body: fragment });
    // No explicit CSP here — the global security middleware applies the strict
    // nonce policy (matching the nonce adminLayout embeds), like any CMS page.
    return c.html(wrapped, upstreamResponse.status as 200);
  }

  // Give full-document plugin pages their own CSP so (a) the CMS's strict nonce
  // CSP isn't imposed on plugin HTML (which would break legitimate plugin
  // scripts) and (b) plugin pages still get baseline hardening. This is NOT
  // origin isolation — see warnSharedOrigin() — it only limits injection
  // into an otherwise-benign plugin.
  const response = new Response(upstreamResponse.body, upstreamResponse);
  // A plugin can opt a full-document response into being shown in a same-origin
  // <iframe> by setting `x-cms-frame: 1` (e.g. an EDM email preview embedded in
  // the editor). Without it the global X-Frame-Options: DENY applies. Same-origin
  // only — the response is still on the CMS origin, so this is not cross-site framing.
  const allowFraming = upstreamResponse.headers.get('x-cms-frame') === '1';
  response.headers.delete('x-cms-frame');
  if (allowFraming) response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (!response.headers.has('Content-Security-Policy')) {
    response.headers.set(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "object-src 'none'",
        "base-uri 'none'",
        allowFraming ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
      ].join('; '),
    );
  }
  return response;
}

/** Decodes the percent-encoded x-cms-title header (plugins encode it for header safety). */
function decodeTitle(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

let sharedOriginWarned = false;
function warnSharedOrigin(): void {
  if (sharedOriginWarned) return;
  sharedOriginWarned = true;
  console.warn(
    'Plugin admin pages are served on the CMS origin; a compromised plugin would '
    + 'gain same-origin authority. Serve plugins from a dedicated origin to isolate them.',
  );
}
