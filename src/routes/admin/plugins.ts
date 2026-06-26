// ============================================================
// Plugin admin shell — renders /admin/plugins/<id>/* as CMS chrome containing
// a sandboxed iframe pointed at the plugin Worker's own /__plugin/admin/* URL.
//
// Mounted under the authenticated, editor-guarded admin router, so
// the signed-in user is already verified. The plugin receives a short-lived
// signed launch token in the iframe URL instead of CMS cookies.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { pluginById, PLUGIN_PREFIX } from '../../plugins/registry';
import type { AppContext } from '../../utils/context';
import { requirePermission } from '../../middleware/auth';
import { escHtml } from '../../templates/layout';
import { adminLayout } from '../../templates/layout';
import { buildBaseProps } from '../../utils/admin-render';
import { viewsFor } from '../../plugins/views';
import {
  buildPluginFrameShellCsp,
  signPluginLaunchToken,
} from '../../security/plugin-proxy';
import { currentCspNonce } from '../../utils/request-context';

export const pluginAdminRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Plugin admin pages can execute arbitrary plugin code. Access still requires
// the explicit plugin capability, while the actual plugin document runs on its
// own origin inside a sandboxed iframe so plugin script does not receive
// CMS-origin authority.
pluginAdminRoutes.use('/plugins/:pluginId', requirePermission('plugin:access'));
pluginAdminRoutes.use('/plugins/:pluginId/*', requirePermission('plugin:access'));

pluginAdminRoutes.get('/plugins/:pluginId', (c) => pluginFrameShell(c));
pluginAdminRoutes.get('/plugins/:pluginId/*', (c) => pluginFrameShell(c));
pluginAdminRoutes.all('/plugins/:pluginId', (c) => c.text('Method Not Allowed', 405));
pluginAdminRoutes.all('/plugins/:pluginId/*', (c) => c.text('Method Not Allowed', 405));

async function pluginFrameShell(c: AppContext): Promise<Response> {
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
  const pluginBase = plugin.binding.replace(/\/+$/, '');
  const pluginOrigin = new URL(pluginBase).origin;
  const pluginPath = `${PLUGIN_PREFIX}/admin${rest || ''}`;
  const frameUrl = new URL(`${pluginBase}${pluginPath}`);
  for (const [key, value] of url.searchParams) frameUrl.searchParams.append(key, value);
  frameUrl.searchParams.set('cms_embed', '1');
  frameUrl.searchParams.set('cms_launch', await signPluginLaunchToken({
    pluginId,
    pluginOrigin,
    path: `${pluginPath}${url.search}`,
    user: c.get('user'),
    secret: plugin.secret,
  }));

  const title = plugin.manifest.name || 'Plugin';
  const base = await buildBaseProps(c);
  const shell = await adminLayout(viewsFor(c.env), base, {
    title,
    body: pluginIframeMarkup(title, frameUrl.toString(), pluginOrigin),
  });
  const response = c.html(shell);
  response.headers.set('Content-Security-Policy', buildPluginFrameShellCsp(currentCspNonce(), pluginOrigin));
  return response;
}

function pluginIframeMarkup(title: string, src: string, pluginOrigin: string): string {
  return `
    <section class="h-[calc(100vh-3.5rem)] md:h-screen bg-white">
      <iframe
        title="${escHtml(title)}"
        src="${escHtml(src)}"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
        referrerpolicy="no-referrer"
        class="block w-full h-full border-0"
        data-plugin-origin="${escHtml(pluginOrigin)}"></iframe>
    </section>
  `;
}
