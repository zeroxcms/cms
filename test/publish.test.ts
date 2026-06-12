import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d1Adapter } from '../src/publish/d1';
import { r2Adapter } from '../src/publish/r2';
import { pluginAdapter } from '../src/publish/plugin';
import {
  getPublishAdapters,
  liveMapForDraftPages,
  publishPageToTargets,
  unpublishPageFromTargets,
} from '../src/publish';
import { clearManifestCache } from '../src/plugins/registry';
import type { PublishSnapshot } from '../src/publish/adapter';
import type { Env, Page, ResolvedPlugin } from '../src/types';

const PAGE: Page = {
  id: 9001,
  uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  created_at: '2026-01-01 00:00:00',
  updated_at: '2026-01-01 00:00:00',
  name: 'Hello',
  slug: 'hello',
  weight: 5,
  start: null,
  end: null,
  page_type: 'default',
  lect: JSON.stringify({ name: { en: 'Hello' } }),
  page_id: null,
  creator: 1,
  editors: null,
};

function snapshotFor(page: Page): PublishSnapshot {
  return {
    page,
    tags: [{ uuid: 'tag-link-uuid', tag_id: 42, weight: 1, slug: 'news', name: 'News' }],
    publishedAt: '2026-06-12T00:00:00.000Z',
  };
}

async function cleanup(): Promise<void> {
  await env.DB.prepare('DELETE FROM draft_page_tags WHERE page_id = ?').bind(PAGE.id).run();
  await env.DB.prepare('DELETE FROM draft_pages WHERE id = ?').bind(PAGE.id).run();
  await env.DB.prepare('DELETE FROM tags WHERE id = 42').run();
  const live = await env.PUBLISHED_DB.prepare('SELECT id FROM live_pages WHERE uuid = ?')
    .bind(PAGE.uuid)
    .first<{ id: number }>();
  if (live) {
    await env.PUBLISHED_DB.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(live.id).run();
  }
  await env.PUBLISHED_DB.prepare('DELETE FROM live_pages WHERE uuid = ?').bind(PAGE.uuid).run();
  await env.MEDIA_BUCKET!.delete(`publish-test/pages/${PAGE.uuid}.json`);
  await env.MEDIA_BUCKET!.delete('publish-test/index.json');
}

beforeEach(async () => {
  clearManifestCache();
  await cleanup();
});

afterEach(cleanup);

describe('d1 adapter', () => {
  it('publishes, reads live state, and unpublishes', async () => {
    const adapter = d1Adapter(env.PUBLISHED_DB);
    await adapter.publish(snapshotFor(PAGE));

    const live = await env.PUBLISHED_DB.prepare('SELECT * FROM live_pages WHERE uuid = ?')
      .bind(PAGE.uuid)
      .first<Page>();
    expect(live?.name).toBe('Hello');
    expect(live?.lect).toBe(PAGE.lect);

    const liveTags = await env.PUBLISHED_DB.prepare(
      'SELECT tag_id FROM live_page_tags WHERE page_id = (SELECT id FROM live_pages WHERE uuid = ?)',
    )
      .bind(PAGE.uuid)
      .all<{ tag_id: number }>();
    expect(liveTags.results.map((row) => row.tag_id)).toEqual([42]);

    expect(await adapter.getLiveLect!(PAGE.uuid)).toBe(PAGE.lect);
    const map = await adapter.liveMap!([PAGE.uuid]);
    expect(map.get(PAGE.uuid)?.weight).toBe(5);
    const byType = await adapter.listLiveByTypes!(['default']);
    expect(byType.some((row) => row.uuid === PAGE.uuid)).toBe(true);

    await adapter.removeTag!(42);
    const afterRemove = await env.PUBLISHED_DB.prepare('SELECT COUNT(*) AS n FROM live_page_tags WHERE tag_id = 42')
      .first<{ n: number }>();
    expect(afterRemove?.n).toBe(0);

    await adapter.unpublish(PAGE.uuid);
    expect(await adapter.getLiveLect!(PAGE.uuid)).toBeNull();
  });
});

describe('r2 adapter', () => {
  it('writes static JSON snapshots and maintains the index', async () => {
    const adapter = r2Adapter(env.MEDIA_BUCKET!, 'publish-test/');
    await adapter.publish(snapshotFor(PAGE));

    const object = await env.MEDIA_BUCKET!.get(`publish-test/pages/${PAGE.uuid}.json`);
    expect(object).not.toBeNull();
    const document = (await object!.json()) as Record<string, unknown>;
    expect(document.slug).toBe('hello');
    expect(document.lect).toEqual({ name: { en: 'Hello' } });
    expect(document.tags).toEqual([{ uuid: 'tag-link-uuid', tag_id: 42, weight: 1, slug: 'news', name: 'News' }]);

    const index = await env.MEDIA_BUCKET!.get('publish-test/index.json');
    const parsedIndex = (await index!.json()) as { pages: Array<{ uuid: string; page_type: string | null }> };
    expect(parsedIndex.pages.map((entry) => entry.uuid)).toEqual([PAGE.uuid]);

    expect(await adapter.getLiveLect!(PAGE.uuid)).toBe(JSON.stringify({ name: { en: 'Hello' } }));
    const byType = await adapter.listLiveByTypes!(['default']);
    expect(byType.map((row) => row.uuid)).toEqual([PAGE.uuid]);

    await adapter.unpublish(PAGE.uuid);
    expect(await env.MEDIA_BUCKET!.get(`publish-test/pages/${PAGE.uuid}.json`)).toBeNull();
    const emptiedIndex = await env.MEDIA_BUCKET!.get('publish-test/index.json');
    expect(((await emptiedIndex!.json()) as { pages: unknown[] }).pages).toEqual([]);
  });
});

describe('plugin adapter', () => {
  function makePublishPlugin(status = 200) {
    const calls: Array<{ path: string; body: Record<string, unknown>; secret: string | null }> = [];
    const fetcher = {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(url).pathname;
        if (path === '/__plugin/manifest') {
          return Response.json({ id: 'ipfs', name: 'IPFS', version: '1.0.0', publishTarget: true });
        }
        calls.push({
          path,
          body: init?.body ? JSON.parse(String(init.body)) : {},
          secret: new Headers(init?.headers).get('x-plugin-secret'),
        });
        return new Response(status === 200 ? 'ok' : 'fail', { status });
      },
    } as unknown as Fetcher;
    const plugin: ResolvedPlugin = {
      binding: 'PLUGIN_IPFS',
      fetcher,
      manifest: { id: 'ipfs', name: 'IPFS', version: '1.0.0', publishTarget: true },
    };
    return { plugin, calls, fetcher };
  }

  it('forwards publish and unpublish with the shared secret', async () => {
    const { plugin, calls } = makePublishPlugin();
    const adapter = pluginAdapter(plugin, 's3cret');

    await adapter.publish(snapshotFor(PAGE));
    await adapter.unpublish(PAGE.uuid);

    expect(calls.map((call) => call.path)).toEqual(['/__plugin/publish/page', '/__plugin/publish/remove']);
    expect(calls[0].secret).toBe('s3cret');
    expect((calls[0].body.page as { uuid: string }).uuid).toBe(PAGE.uuid);
    expect(calls[1].body).toEqual({ uuid: PAGE.uuid });
  });

  it('throws on non-2xx responses so the registry records a failure', async () => {
    const { plugin } = makePublishPlugin(500);
    const adapter = pluginAdapter(plugin, 's3cret');
    await expect(adapter.publish(snapshotFor(PAGE))).rejects.toThrow('returned 500');
  });
});

describe('publish registry', () => {
  function registryEnv(extra: Record<string, unknown> = {}): Env {
    return { ...env, ...extra } as unknown as Env;
  }

  async function seedDraft(): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(PAGE.id, PAGE.uuid, PAGE.name, PAGE.slug, PAGE.weight, PAGE.page_type, PAGE.lect, PAGE.creator)
      .run();
    await env.DB.prepare("INSERT INTO tags (id, name, slug) VALUES (42, 'News', 'news')").run();
    await env.DB.prepare('INSERT INTO draft_page_tags (page_id, tag_id, weight) VALUES (?, 42, 1)')
      .bind(PAGE.id)
      .run();
  }

  it('defaults to the d1 target', async () => {
    const adapters = await getPublishAdapters(registryEnv());
    expect(adapters.map((adapter) => adapter.id)).toEqual(['d1']);
  });

  it('resolves built-in targets from PUBLISH_TARGETS and plugins from manifests', async () => {
    const fetcher = {
      fetch: async () => Response.json({ id: 'ipfs', name: 'IPFS', version: '1.0.0', publishTarget: true }),
    } as unknown as Fetcher;
    const adapters = await getPublishAdapters(registryEnv({
      PUBLISH_TARGETS: 'd1,r2',
      PUBLISH_BUCKET: env.MEDIA_BUCKET,
      PLUGINS: 'PLUGIN_IPFS',
      PLUGIN_IPFS: fetcher,
      PLUGIN_SECRET: 's3cret',
    }));
    expect(adapters.map((adapter) => adapter.id)).toEqual(['d1', 'r2', 'plugin:ipfs']);
  });

  it('publishes a draft to every target and reports partial failures', async () => {
    await seedDraft();
    const failing = {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).pathname === '/__plugin/manifest') {
          return Response.json({ id: 'ipfs', name: 'IPFS', version: '1.0.0', publishTarget: true });
        }
        return new Response('boom', { status: 500 });
      },
    } as unknown as Fetcher;

    const testEnv = registryEnv({
      PLUGINS: 'PLUGIN_IPFS',
      PLUGIN_IPFS: failing,
      PLUGIN_SECRET: 's3cret',
    });

    const outcome = await publishPageToTargets(testEnv, PAGE.id);
    expect(outcome).not.toBeNull();
    expect(outcome!.targets).toEqual(['d1', 'plugin:ipfs']);
    expect(outcome!.failures).toEqual(['plugin:ipfs']);

    // The d1 target still landed, including denormalized tag links.
    const live = await env.PUBLISHED_DB.prepare('SELECT name FROM live_pages WHERE uuid = ?')
      .bind(PAGE.uuid)
      .first<{ name: string }>();
    expect(live?.name).toBe('Hello');

    const map = await liveMapForDraftPages(testEnv, [PAGE]);
    expect(map.get(PAGE.uuid)?.lect).toBe(PAGE.lect);

    const unpublishOutcome = await unpublishPageFromTargets(testEnv, PAGE.uuid);
    expect(unpublishOutcome.failures).toEqual(['plugin:ipfs']);
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM live_pages WHERE uuid = ?').bind(PAGE.uuid).first()).toBeNull();
  });

  it('returns null when the draft page does not exist', async () => {
    expect(await publishPageToTargets(registryEnv(), 999999)).toBeNull();
  });
});
