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

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pluginAdminRoutes.all('/plugins/:pluginId', (c) => proxyToPlugin(c));
pluginAdminRoutes.all('/plugins/:pluginId/*', (c) => proxyToPlugin(c));

async function proxyToPlugin(c: AppContext): Promise<Response> {
  const pluginId = c.req.param('pluginId');
  if (!pluginId) return c.notFound();
  const plugin = await pluginById(c.env, pluginId);
  if (!plugin) return c.notFound();

  const url = new URL(c.req.url);
  const prefix = `/admin/plugins/${pluginId}`;
  const rest = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  const upstream = `${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/admin${rest}${url.search}`;

  const user = c.get('user');
  const headers = new Headers(c.req.raw.headers);
  headers.set(
    'x-cms-user',
    JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  );
  if (c.env.PLUGIN_SECRET) headers.set('x-plugin-secret', c.env.PLUGIN_SECRET);
  // Never leak CMS session/auth cookies to the plugin Worker.
  headers.delete('cookie');

  const hasBody = c.req.method !== 'GET' && c.req.method !== 'HEAD';
  return plugin.fetcher.fetch(upstream, {
    method: c.req.method,
    headers,
    body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
  });
}
