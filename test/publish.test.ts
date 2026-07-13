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
  unpublishPagesFromTargets,
} from '../src/publish';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/plugins/registry';
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
  timezone: null,
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
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
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
    expect(live?.id).toBe(PAGE.id);
    expect(live?.name).toBe('Hello');
    expect(live?.lect).toBe(PAGE.lect);

    const liveTags = await env.PUBLISHED_DB.prepare(
      'SELECT page_id, tag_id FROM live_page_tags WHERE page_id = (SELECT id FROM live_pages WHERE uuid = ?)',
    )
      .bind(PAGE.uuid)
      .all<{ page_id: number; tag_id: number }>();
    expect(liveTags.results.map((row) => row.tag_id)).toEqual([42]);
    expect(liveTags.results.map((row) => row.page_id)).toEqual([PAGE.id]);

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

  it('unpublishMany removes several live pages and their tags in one pass', async () => {
    const adapter = d1Adapter(env.PUBLISHED_DB);
    const second: Page = { ...PAGE, id: PAGE.id + 5, uuid: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee', slug: 'hello-2' };
    const secondSnapshot: PublishSnapshot = {
      page: second,
      tags: [{ uuid: 'tag-link-uuid-2', tag_id: 42, weight: 1, slug: 'news', name: 'News' }],
      publishedAt: '2026-06-12T00:00:00.000Z',
    };
    try {
      await adapter.publish(snapshotFor(PAGE));
      await adapter.publish(secondSnapshot);

      await adapter.unpublishMany!([PAGE.uuid, second.uuid]);

      expect(await env.PUBLISHED_DB.prepare('SELECT COUNT(*) AS n FROM live_pages WHERE uuid IN (?, ?)')
        .bind(PAGE.uuid, second.uuid)
        .first<{ n: number }>()).toEqual({ n: 0 });
      expect(await env.PUBLISHED_DB.prepare('SELECT COUNT(*) AS n FROM live_page_tags WHERE page_id IN (?, ?)')
        .bind(PAGE.id, second.id)
        .first<{ n: number }>()).toEqual({ n: 0 });
    } finally {
      await env.PUBLISHED_DB.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(second.id).run();
      await env.PUBLISHED_DB.prepare('DELETE FROM live_pages WHERE uuid = ?').bind(second.uuid).run();
    }
  });

  it('unpublishPagesFromTargets skips submission mirrors and reports refusedCount', async () => {
    const adapter = d1Adapter(env.PUBLISHED_DB);
    await adapter.publish(snapshotFor(PAGE));

    const outcome = await unpublishPagesFromTargets(env as unknown as Env, [
      { uuid: PAGE.uuid, page_type: 'default' },
      { uuid: 'no-such-submission-uuid', page_type: 'rsvp_response' },
    ]);

    expect(outcome.refusedCount).toBe(1);
    expect(outcome.failures).toEqual([]);
    expect(await env.PUBLISHED_DB.prepare('SELECT COUNT(*) AS n FROM live_pages WHERE uuid = ?')
      .bind(PAGE.uuid)
      .first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('republishes older live rows using the draft page id', async () => {
    const legacyLiveId = PAGE.id + 1;
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO live_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(legacyLiveId, PAGE.uuid, 'Old', 'old', 9, PAGE.page_type, '{}', PAGE.creator, PAGE.editors)
      .run();
    await env.PUBLISHED_DB.prepare('INSERT INTO live_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
      .bind('legacy-tag-link', legacyLiveId, 99, 1)
      .run();

    const adapter = d1Adapter(env.PUBLISHED_DB);
    await adapter.publish(snapshotFor(PAGE));

    const live = await env.PUBLISHED_DB.prepare('SELECT id, name FROM live_pages WHERE uuid = ?')
      .bind(PAGE.uuid)
      .first<{ id: number; name: string }>();
    expect(live).toEqual({ id: PAGE.id, name: PAGE.name });

    const liveTags = await env.PUBLISHED_DB.prepare('SELECT page_id, tag_id FROM live_page_tags WHERE uuid IN (?, ?)')
      .bind('legacy-tag-link', 'tag-link-uuid')
      .all<{ page_id: number; tag_id: number }>();
    expect(liveTags.results).toEqual([{ page_id: PAGE.id, tag_id: 42 }]);
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

describe('example publish plugins', () => {
  // Drives the real example plugin Workers end-to-end: CMS pluginAdapter →
  // plugin fetch handler → stubbed external API (webhook receiver / Pinata).
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fetcherFor(handler: { fetch(request: Request, env: never): Promise<Response> }, pluginEnv: unknown): Fetcher {
    return {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handler.fetch(new Request(input as RequestInfo, init), pluginEnv as never),
    } as unknown as Fetcher;
  }

  it('webhook plugin delivers signed events', async () => {
    const { default: webhookPlugin } = await import('../../cms-plugin-publish-webhook/src/index');
    const deliveries: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      deliveries.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      return new Response('ok');
    }) as typeof fetch;

    const pluginEnv = {
      PLUGIN_SECRET: 's3cret',
      WEBHOOK_URLS: 'https://receiver.test/hook',
      WEBHOOK_SECRET: 'whsec',
    };
    const adapter = pluginAdapter({
      binding: 'PLUGIN_PUBLISH_WEBHOOK',
      fetcher: fetcherFor(webhookPlugin, pluginEnv),
      manifest: { id: 'publish-webhook', name: 'Webhook Publisher', version: '1.0.0', publishTarget: true },
    }, 's3cret');

    await adapter.publish(snapshotFor(PAGE));
    await adapter.unpublish(PAGE.uuid);
    await adapter.removeTag!(42);

    expect(deliveries.map((d) => d.body.event)).toEqual(['page.published', 'page.removed', 'tag.removed']);
    expect(deliveries[0].url).toBe('https://receiver.test/hook');
    expect((deliveries[0].body.data as { page: { uuid: string } }).page.uuid).toBe(PAGE.uuid);
    expect(deliveries[0].headers.get('x-cms-signature')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(deliveries[1].body.data).toEqual({ uuid: PAGE.uuid });
  });

  it('webhook plugin reports receiver failures back to the CMS', async () => {
    const { default: webhookPlugin } = await import('../../cms-plugin-publish-webhook/src/index');
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;

    const adapter = pluginAdapter({
      binding: 'PLUGIN_PUBLISH_WEBHOOK',
      fetcher: fetcherFor(webhookPlugin, { PLUGIN_SECRET: 's3cret', WEBHOOK_URLS: 'https://receiver.test/hook' }),
      manifest: { id: 'publish-webhook', name: 'Webhook Publisher', version: '1.0.0', publishTarget: true },
    }, 's3cret');

    await expect(adapter.publish(snapshotFor(PAGE))).rejects.toThrow('returned 502');
  });

  it('ipfs plugin pins on publish, unpins the previous CID, and unpins on remove', async () => {
    const { default: ipfsPlugin } = await import('../../cms-plugin-publish-ipfs/src/index');
    const pins: string[] = [];
    const unpins: string[] = [];
    let nextCid = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pinning/pinJSONToIPFS')) {
        const cid = `bafy${++nextCid}`;
        pins.push(JSON.parse(String(init?.body)).pinataMetadata.name);
        return Response.json({ IpfsHash: cid });
      }
      if (url.includes('/pinning/unpin/')) {
        unpins.push(url.split('/').pop()!);
        return new Response('ok');
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;

    const kvStore = new Map<string, string>();
    const fakeKv = {
      get: async (key: string) => kvStore.get(key) ?? null,
      put: async (key: string, value: string) => void kvStore.set(key, value),
      delete: async (key: string) => void kvStore.delete(key),
    };
    const pluginEnv = { PLUGIN_SECRET: 's3cret', PINATA_JWT: 'jwt', PIN_INDEX: fakeKv };

    const adapter = pluginAdapter({
      binding: 'PLUGIN_PUBLISH_IPFS',
      fetcher: fetcherFor(ipfsPlugin, pluginEnv),
      manifest: { id: 'publish-ipfs', name: 'IPFS Publisher', version: '1.0.0', publishTarget: true },
    }, 's3cret');

    await adapter.publish(snapshotFor(PAGE));
    expect(kvStore.get(PAGE.uuid)).toBe('bafy1');

    // Republish: pins a new CID and unpins the superseded one.
    await adapter.publish(snapshotFor(PAGE));
    expect(kvStore.get(PAGE.uuid)).toBe('bafy2');
    expect(unpins).toEqual(['bafy1']);
    expect(pins).toEqual([`cms-page-${PAGE.uuid}`, `cms-page-${PAGE.uuid}`]);

    await adapter.unpublish(PAGE.uuid);
    expect(unpins).toEqual(['bafy1', 'bafy2']);
    expect(kvStore.has(PAGE.uuid)).toBe(false);

    // remove-tag is unimplemented (404) — the adapter must tolerate it.
    await expect(adapter.removeTag!(42)).resolves.toBeUndefined();
  });

  it('plugins reject publish calls without the shared secret', async () => {
    const { default: webhookPlugin } = await import('../../cms-plugin-publish-webhook/src/index');
    const response = await webhookPlugin.fetch(
      new Request('https://plugin.local/__plugin/publish/page', { method: 'POST', body: '{}' }),
      { PLUGIN_SECRET: 's3cret', WEBHOOK_URLS: 'https://receiver.test/hook' } as never,
    );
    expect(response.status).toBe(403);
  });
});

describe('publish registry', () => {
  function registryEnv(extra: Record<string, unknown> = {}): Env {
    return { ...env, ...extra } as unknown as Env;
  }

  // Registers a plugin in the D1 registry and routes its URL to an in-process
  // fetcher (the URL-transport equivalent of the old service binding).
  async function registerPlugin(fetcher: Fetcher, url = 'https://plugin-ipfs.local'): Promise<void> {
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('IPFS', url).run();
    __injectPluginFetcher(url, fetcher);
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
    await registerPlugin(fetcher);
    const adapters = await getPublishAdapters(registryEnv({
      PUBLISH_TARGETS: 'd1,r2',
      PUBLISH_BUCKET: env.MEDIA_BUCKET,
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

    await registerPlugin(failing);
    const testEnv = registryEnv({
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

  // ── Publish-time lect projection (contentTypes.publishLect) ───────────────
  describe('lect projection', () => {
    const GUEST_LECT = {
      _type: 'guest',
      _pointers: { mail_list: '8', event: '7' },
      name: { en: 'Ada' },
      email: 'ada@x.io',
      status: 'confirmed',
      plus_guests: '1',
      response: [{ status: 'confirmed', date: '2026-06-01' }],
      // Private operational fields that must never reach the published DB:
      phone: '+44 555 0100',
      wechat: 'ada-wc',
      remarks: 'VIP handling',
      checkin: [{ status: 'checked-in' }],
      qrcode: 'QR123',
    };

    function projectingPlugin(): Fetcher {
      return {
        fetch: async () => Response.json({
          id: 'events-test',
          name: 'Events Test',
          version: '1.0.0',
          contentTypes: {
            blueprint: { guest: ['@email', 'name'], event: ['@checkin_lite_passcode', 'name'] },
            publishLect: {
              guest: { keep: ['name', 'email', 'status', 'plus_guests', 'response'] },
              event: { drop: ['checkin_lite_passcode'] },
              // Not owned by this plugin — must be ignored.
              article: { keep: ['name'] },
            },
          },
        }),
      } as unknown as Fetcher;
    }

    async function seedTypedDraft(pageType: string, lect: Record<string, unknown>): Promise<void> {
      await env.DB.prepare(
        `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(PAGE.id, PAGE.uuid, PAGE.name, PAGE.slug, PAGE.weight, pageType, JSON.stringify(lect), PAGE.creator)
        .run();
    }

    it('keeps only allow-listed guest fields (plus structural keys) in the live copy', async () => {
      await registerPlugin(projectingPlugin());
      await seedTypedDraft('guest', GUEST_LECT);
      const testEnv = registryEnv({ PLUGIN_SECRET: 's3cret' });

      const outcome = await publishPageToTargets(testEnv, PAGE.id);
      expect(outcome?.failures).toEqual([]);

      const live = await env.PUBLISHED_DB.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
        .bind(PAGE.uuid)
        .first<{ lect: string }>();
      const liveLect = JSON.parse(live!.lect) as Record<string, unknown>;
      expect(liveLect).toMatchObject({
        _type: 'guest',
        _pointers: { mail_list: '8', event: '7' },
        name: { en: 'Ada' },
        email: 'ada@x.io',
        status: 'confirmed',
        plus_guests: '1',
        response: [{ status: 'confirmed', date: '2026-06-01' }],
      });
      for (const key of ['phone', 'wechat', 'remarks', 'checkin', 'qrcode']) {
        expect(liveLect, `${key} must not be published`).not.toHaveProperty(key);
      }
      // The draft copy is untouched — projection happens only at publish.
      const draft = await env.DB.prepare('SELECT lect FROM draft_pages WHERE id = ?')
        .bind(PAGE.id)
        .first<{ lect: string }>();
      expect(JSON.parse(draft!.lect)).toHaveProperty('phone');
    });

    it('drop-mode strips secrets from event pages; unowned rules are ignored', async () => {
      await registerPlugin(projectingPlugin());
      const { publishLectRules, projectLect } = await import('../src/publish/projection');
      const rules = await publishLectRules(registryEnv({ PLUGIN_SECRET: 's3cret' }));
      expect(rules.guest).toBeTruthy();
      expect(rules.event).toEqual({ drop: ['checkin_lite_passcode'] });
      expect(rules.article).toBeUndefined(); // blueprint ownership required

      const eventLect = JSON.stringify({ _type: 'event', name: { en: 'Launch' }, checkin_lite_passcode: '1234' });
      const projected = JSON.parse(projectLect(eventLect, rules.event)!) as Record<string, unknown>;
      expect(projected).toMatchObject({ _type: 'event', name: { en: 'Launch' } });
      expect(projected).not.toHaveProperty('checkin_lite_passcode');

      // No rule → byte-identical passthrough (drift comparisons rely on this).
      expect(projectLect(eventLect, undefined)).toBe(eventLect);
    });

    it('keeps the dashboard drift badge clean for projected types', async () => {
      await registerPlugin(projectingPlugin());
      await seedTypedDraft('guest', GUEST_LECT);
      const testEnv = registryEnv({ PLUGIN_SECRET: 's3cret' });
      await publishPageToTargets(testEnv, PAGE.id);

      const { draftLectProjector } = await import('../src/publish/projection');
      const { withLiveStatus } = await import('../src/utils/page-logic');
      const draft = await env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
        .bind(PAGE.id)
        .first<Page>();
      const liveMap = await liveMapForDraftPages(testEnv, [draft!]);
      const projectDraft = await draftLectProjector(testEnv);

      // Unprojected comparison would report permanent drift…
      const [naive] = withLiveStatus([draft!], liveMap);
      expect(naive.hasLiveLectDrift).toBe(true);
      // …the projected comparison must not.
      const [projected] = withLiveStatus([draft!], liveMap, projectDraft);
      expect(projected.isPublished).toBe(true);
      expect(projected.hasLiveLectDrift).toBe(false);
    });
  });
});
