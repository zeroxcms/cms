import { beforeEach, describe, expect, it } from 'vitest';
import { resolveCmsConfig, clearConfigCache } from '../src/plugins/config';
import { clearManifestCache } from '../src/plugins/registry';
import { deliverHook } from '../src/plugins/hooks';
import { viewsFor } from '../src/plugins/views';
import { cmsConfig } from '../src/cms-config';
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
  hookCalls: Array<{ event: string; body: Record<string, unknown> | null }>;
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

function envWith(plugin: FakePlugin, extra: Record<string, unknown> = {}): Env {
  return { PLUGINS: 'PLUGIN_TEST', PLUGIN_TEST: plugin.fetcher, ...extra } as unknown as Env;
}

const USER: JWTPayload = {
  sub: '7', email: 'a@b.co', name: 'Ada', role: 'admin', type: 'access', exp: 0, iat: 0,
};

beforeEach(() => {
  clearConfigCache();
  clearManifestCache();
});

describe('resolveCmsConfig', () => {
  it('merges plugin blueprints into the base config', async () => {
    const config = await resolveCmsConfig(envWith(makePlugin(EVENTS_MANIFEST)));
    expect(config.blueprint.event).toEqual(['@date', 'venue']);
    expect(config.blueprint.default).toBeDefined(); // base content types preserved
  });

  it('does not mutate the static base config', async () => {
    await resolveCmsConfig(envWith(makePlugin(EVENTS_MANIFEST)));
    expect(cmsConfig.blueprint.event).toBeUndefined();
  });

  it('returns the base config when no plugins are configured', async () => {
    const config = await resolveCmsConfig({} as Env);
    expect(config.blueprint.event).toBeUndefined();
  });
});

describe('deliverHook', () => {
  it('delivers to plugins subscribed to the event with the page + user payload', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(envWith(plugin, { PLUGIN_SECRET: 's' }), USER, 'publish', { id: 5, slug: 'x' });
    expect(plugin.hookCalls).toHaveLength(1);
    expect(plugin.hookCalls[0].event).toBe('publish');
    expect(plugin.hookCalls[0].body?.page).toMatchObject({ id: 5, slug: 'x' });
    expect(plugin.hookCalls[0].body?.user).toMatchObject({ id: '7', role: 'admin' });
  });

  it('does not deliver events the plugin did not subscribe to', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST);
    await deliverHook(envWith(plugin), undefined, 'delete', { id: 1 });
    expect(plugin.hookCalls).toHaveLength(0);
  });
});

describe('viewsFor', () => {
  const snippetPath = '/snippets/pagefield/events-map/basic.liquid';

  it('falls back to a plugin view when the primary assets 404', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const env = envWith(plugin, { VIEWS: { fetch: async () => new Response('nf', { status: 404 }) } });
    const res = await viewsFor(env).fetch(`https://views.local${snippetPath}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PLUGIN_SNIPPET');
  });

  it('serves primary views without consulting plugins', async () => {
    const plugin = makePlugin(EVENTS_MANIFEST, { [snippetPath]: 'PLUGIN_SNIPPET' });
    const env = envWith(plugin, { VIEWS: { fetch: async () => new Response('CORE') } });
    const res = await viewsFor(env).fetch('https://views.local/layout/default.liquid');
    expect(await res.text()).toBe('CORE');
  });
});
