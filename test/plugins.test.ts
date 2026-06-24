import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveCmsConfig, clearConfigCache } from '../src/plugins/config';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/plugins/registry';
import { deliverHook } from '../src/plugins/hooks';
import { viewsFor } from '../src/plugins/views';
import { cmsConfig } from '../src/cms-config';
import { signJWT } from '../src/utils/jwt';
import type { Env, JWTPayload } from '../src/types';

const EVENTS_MANIFEST = {
  id: 'events',
  name: 'Events',
  version: '1.0.0',
  hooks: ['publish'],
  nav: [{ label: 'Events', href: 'dashboard' }],
  contentTypes: { blueprint: { event: ['@date', 'venue'] } },
  fieldTypes: [{ type: 'events-map' }],
};

interface FakePlugin {
  fetcher: Fetcher;
  hookCalls: Array<{ event: string; body: Record<string, unknown> | null; headers: Headers }>;
}

function makePlugin(manifest: unknown, views: Record<string, string> = {}): FakePlugin {
  const hookCalls: FakePlugin['hookCalls'] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === '/__plugin/manifest') return Response.json(manifest);
    if (path.startsWith('/__plugin/hooks/')) {
      hookCalls.push({
        event: path.split('/').pop() ?? '',
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });
      return new Response('ok');
    }
    if (path.startsWith('/__plugin/views/')) {
      const viewPath = path.slice('/__plugin/views'.length);
      return viewPath in views ? new Response(views[viewPath]) : new Response('nf', { status: 404 });
    }
    return new Response('nf', { status: 404 });
  };
  return { hookCalls, fetcher: { fetch } as unknown as Fetcher };
}

// Registers a fake plugin in the D1 registry and routes its URL to the in-process
// fetcher — the URL-transport equivalent of the old PLUGINS service binding.
async function envWith(plugin: FakePlugin, extra: Record<string, unknown> = {}): Promise<Env> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
  __injectPluginFetcher(url, plugin.fetcher);
  return { DB: env.DB, ...extra } as unknown as Env;
}

const USER: JWTPayload = {
  sub: '7', email: 'a@b.co', name: 'Ada', role: 'admin', type: 'access', exp: 0, iat: 0,
};

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
});

describe('resolveCmsConfig', () => {
  it('merges plugin blueprints into the base config', async () => {
    const config = await resolveCmsConfig(await envWith(makePlugin(EVENTS_MANIFEST)));
    expect(config.blueprint.event).toEqual(['@date', 'venue']);
    expect(config.blueprint.default).toBeDefined(); // base content types preserved
  });

  it('does not mutate the static base config', async () => {
    await resolveCmsConfig(await envWith(makePlugin(EVENTS_MANIFEST)));
    expect(cmsConfig.blueprint.event).toBeUndefined();
  });

  it('returns the base config when no plugins are configured', async () => {
    const config = await resolveCmsConfig({} as Env);
    expect(config.blueprint.event).toBeUndefined();
  });

  it('merges database-defined page types into the config', async () => {
    await env.DB.prepare(
      `INSERT INTO page_types (slug, name, blueprint, taxonomy_lists) VALUES (?, ?, ?, ?)`,
    )
      .bind('dbtype', 'DB Type', JSON.stringify(['name', 'body:text']), JSON.stringify(['years']))
      .run();
    try {
      const config = await resolveCmsConfig({ DB: env.DB } as Env);
      expect(config.blueprint.dbtype).toEqual(['name', 'body:text']);
      expect(config.taxonomyLists.dbtype).toEqual(['years']);
      expect(config.blueprint.default).toBeDefined(); // base content types preserved
      expect(cmsConfig.blueprint.dbtype).toBeUndefined(); // base not mutated
    } finally {
      await env.DB.prepare('DELETE FROM page_types WHERE slug = ?').bind('dbtype').run();
    }
  });

  it('merges database-defined block types into the config blocks', async () => {
    await env.DB.prepare(
      `INSERT INTO block_types (slug, name, blueprint) VALUES (?, ?, ?)`,
    )
      .bind('dbblock', 'DB Block', JSON.stringify(['label', { pictures: ['url'] }]))
      .run();
    try {
      const config = await resolveCmsConfig({ DB: env.DB } as Env);
      expect(config.blocks.dbblock).toEqual(['label', { pictures: ['url'] }]);
      expect(config.blocks.default).toBeDefined(); // base blocks preserved
      expect(cmsConfig.blocks.dbblock).toBeUndefined(); // base not mutated
    } finally {
      await env.DB.prepare('DELETE FROM block_types WHERE slug = ?').bind('dbblock').run();
    }
  });
});

describe('deliverHook', () => {
  it('delivers to plugins subscribed to the event with the page + user payload', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin, { PLUGIN_SECRET: 's' }), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls).toHaveLength(1);
    expect(plugin.hookCalls[0].event).toBe('publish');
    expect(plugin.hookCalls[0].headers.get('x-plugin-secret')).toBe('s');
    expect(plugin.hookCalls[0].body?.page).toMatchObject({ id: 5, slug: 'x' });
    expect(plugin.hookCalls[0].body?.user).toMatchObject({ id: '7', role: 'admin' });
  });

  it('does not deliver subscribed hooks when PLUGIN_SECRET is missing', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls).toHaveLength(0);
  });

  it('does not deliver events the plugin did not subscribe to', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(await envWith(plugin), undefined, 'delete', { id: 1 });
    expect(plugin.hookCalls).toHaveLength(0);
  });
});

describe('viewsFor', () => {
  const snippetPath = '/snippets/pagefield/events-map/basic.liquid';

  it('falls back to a plugin view when the primary assets 404', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const pluginEnv = await envWith(plugin, { VIEWS: { fetch: async () => new Response('nf', { status: 404 }) } });
    const res = await viewsFor(pluginEnv).fetch(`https://views.local${snippetPath}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PLUGIN_SNIPPET');
  });

  it('serves primary views without consulting plugins', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const pluginEnv = await envWith(plugin, { VIEWS: { fetch: async () => new Response('CORE') } });
    const res = await viewsFor(pluginEnv).fetch('https://views.local/layout/default.liquid');
    expect(await res.text()).toBe('CORE');
  });
});

describe('plugin admin proxy', () => {
  const worker = (exports as unknown as { default: Fetcher }).default;
  const testEnv = env as unknown as Record<string, unknown>;
  let savedBindings: Record<string, unknown>;

  beforeEach(() => {
    savedBindings = {
      PLUGINS: testEnv.PLUGINS,
      PLUGIN_TEST: testEnv.PLUGIN_TEST,
      PLUGIN_SECRET: testEnv.PLUGIN_SECRET,
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedBindings)) {
      if (value === undefined) delete testEnv[key];
      else testEnv[key] = value;
    }
  });

  it('never forwards client cookies or smuggled trust headers to the plugin', async () => {
    const captured: Array<{ url: string; headers: Headers }> = [];
    testEnv.PLUGIN_SECRET = 'server-secret';
    const pluginUrl = 'https://plugin-proxy.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', pluginUrl).run();
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        captured.push({ url, headers: new Headers(init?.headers) });
        return new Response('plugin ok');
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: {
        Cookie: `access_token=${token}`,
        'Sec-Fetch-Site': 'same-origin',
        'x-plugin-secret': 'attacker-value',
        'x-cms-user': '{"id":"999","role":"admin"}',
      },
    }));

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    const forwarded = captured[0].headers;
    expect(forwarded.get('cookie')).toBeNull();
    expect(forwarded.get('x-plugin-secret')).toBe('server-secret');
    // x-cms-user must be the server-derived identity, not the client header.
    expect(JSON.parse(forwarded.get('x-cms-user') ?? '{}')).toMatchObject({ id: '1', email: 'admin@example.com' });
  });

  it('fails closed when a plugin has no secret and no PLUGIN_SECRET fallback', async () => {
    delete testEnv.PLUGIN_SECRET;
    // A registered, reachable plugin (manifest resolves) but with no row secret
    // and no env fallback must not be proxied to unauthenticated.
    const url = 'https://plugin-nosecret.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('unexpected plugin call', { status: 500 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: {
        Cookie: `access_token=${token}`,
        'Sec-Fetch-Site': 'same-origin',
      },
    }));

    expect(response.status).toBe(500);
    expect(response.headers.get('X-CMS-Error')).toBe('plugin-secret-required');
  });

  it('wraps an x-cms-chrome fragment in the CMS admin layout', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-chrome.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        // A body fragment opting into the CMS chrome, with a non-ASCII title.
        return new Response('<div class="ev-wrap">FRAGMENT_MARKER</div>', {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'x-cms-chrome': '1',
            'x-cms-title': encodeURIComponent('Gala 晚宴'),
          },
        });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/dashboard', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('FRAGMENT_MARKER');                 // the plugin's content
    expect(body).toContain('/assets/admin.css');               // CMS layout chrome
    expect(body).toContain('Sign out');                        // CMS sidebar
    expect(body).toContain('Gala 晚宴');                        // decoded unicode title
    // Wrapped pages get the CMS strict nonce CSP, not the relaxed plugin policy.
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self' 'nonce-");
    // Default admin pages stay un-frameable.
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('lets a plugin full-document response opt into same-origin framing', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-frame.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        // A full document (no x-cms-chrome) opting into same-origin framing.
        return new Response('<!doctype html><title>Preview</title><body>EMAIL</body>', {
          headers: { 'content-type': 'text/html; charset=utf-8', 'x-cms-frame': '1' },
        });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/plugins/events/edm/5/preview', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    // The CMS turns the opt-in into same-origin framing instead of the global DENY.
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'");
    // The internal opt-in header isn't leaked to the browser.
    expect(response.headers.get('x-cms-frame')).toBeNull();
  });

  it('renders plugin nav items in the admin sidebar', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-nav.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);

    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    // The plugin's nav entry (EVENTS_MANIFEST.nav) must reach the rendered sidebar.
    expect(body).toContain('/admin/plugins/events/dashboard');
    expect(body).toContain('Events');
  });

  it('renders an event page edit view from the plugin and falls back when it declines', async () => {
    testEnv.PLUGIN_SECRET = 'server-secret';
    const url = 'https://plugin-editview.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const manifest = { ...EVENTS_MANIFEST, editViews: ['event'] };
    let serveEditView = true;
    const captured: Array<{ body: unknown; headers: Headers }> = [];
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(u).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        if (path === '/__plugin/edit') {
          captured.push({ body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) });
          if (!serveEditView) return new Response('nf', { status: 404 });
          return new Response('<form>PLUGIN_EDIT_MARKER</form>', {
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'x-cms-chrome': '1',
              'x-cms-title': encodeURIComponent('Edit event'),
            },
          });
        }
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const insert = await env.DB.prepare(
      'INSERT INTO draft_pages (name, slug, weight, page_type, lect) VALUES (?, ?, ?, ?, ?)',
    ).bind('Gala', 'gala', 5, 'event', '{}').run();
    const row = await env.DB.prepare('SELECT id FROM draft_pages WHERE rowid = ?')
      .bind(insert.meta.last_row_id).first<{ id: number }>();
    const pageId = row!.id;

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const request = (query = '') => new Request(`http://localhost/admin/pages/${pageId}/edit${query}`, {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    });

    try {
      const served = await worker.fetch(request());
      expect(served.status).toBe(200);
      const servedBody = await served.text();
      expect(servedBody).toContain('PLUGIN_EDIT_MARKER');   // plugin-rendered form
      expect(servedBody).toContain('/assets/admin.css');    // wrapped in CMS chrome
      expect(servedBody).toContain('Edit event');           // decoded title
      // The CMS hands the plugin the editor context + trusted user, with the
      // form action pointing back at the CMS save handler.
      expect(captured).toHaveLength(1);
      expect(captured[0].headers.get('x-plugin-secret')).toBe('server-secret');
      expect(captured[0].body).toMatchObject({
        mode: 'edit',
        action: `/admin/pages/${pageId}`,
        pageType: 'event',
        page: { id: pageId, name: 'Gala', slug: 'gala' },
      });

      // ?native=1 forces the built-in editor without consulting the plugin.
      const native = await worker.fetch(request('?native=1'));
      expect(native.status).toBe(200);
      const nativeBody = await native.text();
      expect(nativeBody).not.toContain('PLUGIN_EDIT_MARKER');
      expect(nativeBody).toContain('name="name"');                 // built-in editor fields
      expect(nativeBody).toContain('action="/admin/pages/' + pageId + '?native=1"'); // flag carried into the form
      expect(captured).toHaveLength(1); // plugin /__plugin/edit was not called again

      // When the plugin declines (404), the CMS renders its built-in editor.
      clearManifestCache();
      serveEditView = false;
      const fallback = await worker.fetch(request());
      expect(fallback.status).toBe(200);
      const fallbackBody = await fallback.text();
      expect(fallbackBody).not.toContain('PLUGIN_EDIT_MARKER');
      expect(fallbackBody).toContain('name="name"'); // built-in editor fields
    } finally {
      await env.DB.prepare('DELETE FROM draft_pages WHERE id = ?').bind(pageId).run();
    }
  });

  it('shows the contributing plugin name beside its page types', async () => {
    const url = 'https://plugin-page-types.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Event tools', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(EVENTS_MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-page-type-plugin="event" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">plugin (Events)</span>');
  });

  it('lists plugin-contributed block types with the contributing plugin name', async () => {
    const url = 'https://plugin-block-types.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Event tools', url).run();
    const manifest = { id: 'events', name: 'Events', version: '1.0.0', contentTypes: { blocks: { hero: ['label'] } } };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/block_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-block-type-plugin="hero" class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-100 text-emerald-700">plugin (Events)</span>');
  });

  it('places a group:settings nav item inside the Settings group, not the top level', async () => {
    const url = 'https://plugin-settings-nav.local';
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Test', url).run();
    const manifest = {
      id: 'events', name: 'Events', version: '1.0.0',
      nav: [
        { label: 'Events', href: 'dashboard', roles: ['admin', 'editor'] },
        { label: 'Mail Settings', href: 'mail-settings', group: 'settings', roles: ['admin', 'editor'] },
      ],
    };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(u).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({
      sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin',
      type: 'access', exp: now + 900, iat: now,
    }, env.JWT_SECRET);
    const response = await worker.fetch(new Request('http://localhost/admin/page_types', {
      headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin' },
    }));

    expect(response.status).toBe(200);
    const body = await response.text();
    const trashIdx = body.indexOf('/admin/trash');
    const settingsNavIdx = body.indexOf('/admin/plugins/events/mail-settings');
    const topNavIdx = body.indexOf('/admin/plugins/events/dashboard');
    // The Settings group renders before Trash; top-level plugin nav renders after.
    expect(settingsNavIdx).toBeGreaterThan(-1);
    expect(settingsNavIdx).toBeLessThan(trashIdx);
    expect(topNavIdx).toBeGreaterThan(trashIdx);
  });
});
