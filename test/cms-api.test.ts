import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/plugins/registry';
import { clearConfigCache } from '../src/plugins/config';

// F1 — plugin write-back API (/__cms/*). Exercises the real Worker so the
// global middleware (canonical host, cross-origin exemption, auth) is in play.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';

// Manifest the F1 scope derives from: this plugin owns the event RSVP types.
const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  hooks: ['delete'],
  contentTypes: {
    blueprint: {
      event: ['@start', '@end', 'name:text/title', 'location'],
      guest: ['@email:email', '@status', '@rsvp_code', 'name', 'last_name'],
      mail_list: ['*event'],
    },
    // May read `contact` pages (owned elsewhere) but not create/update them.
    readTypes: ['contact'],
  },
};

let savedSecret: unknown;

async function registerPlugin(): Promise<void> {
  const url = `https://plugin-${crypto.randomUUID()}.local`;
  await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
  __injectPluginFetcher(url, {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(href).pathname;
      if (path === '/__plugin/manifest') return Response.json(MANIFEST);
      if (path.startsWith('/__plugin/hooks/')) return new Response('ok');
      return new Response('nf', { status: 404 });
    },
  } as unknown as Fetcher);
}

/** Issues an F1 request through the real Worker with plugin auth headers. */
function cmsApi(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return worker.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      'x-plugin-secret': PLUGIN_SECRET,
      'x-plugin-id': PLUGIN_ID,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }));
}

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare("DELETE FROM draft_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  await registerPlugin();
});

afterEach(() => {
  if (savedSecret === undefined) delete testEnv.PLUGIN_SECRET;
  else testEnv.PLUGIN_SECRET = savedSecret;
});

describe('F1 auth + scoping', () => {
  it('rejects a wrong shared secret', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-secret': 'wrong' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing plugin id', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-id': '' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown plugin id', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest' }, { 'x-plugin-id': 'nope' });
    expect(res.status).toBe(403);
  });

  it('rejects writes to a page type the plugin does not own', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'X' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('is not blocked by the cross-origin mutation guard (no Origin header)', async () => {
    // A 201 here proves the /__cms exemption works — a browser-style guard would 403.
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'NoOrigin' });
    expect(res.status).toBe(201);
  });

  it('authenticates against the plugin\'s own secret, not the env fallback', async () => {
    // Re-register the events plugin with a dedicated row secret.
    await env.DB.prepare('DELETE FROM plugins').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled, secret) VALUES (?, ?, 1, ?)')
      .bind('Events', url, 'per-plugin-secret').run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(MANIFEST);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    // The plugin's own secret is accepted...
    const ok = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'OwnSecret' }, { 'x-plugin-secret': 'per-plugin-secret' });
    expect(ok.status).toBe(201);

    // ...and the shared env PLUGIN_SECRET no longer is — the per-plugin secret wins.
    const rejected = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'EnvSecret' }, { 'x-plugin-secret': PLUGIN_SECRET });
    expect(rejected.status).toBe(403);
  });
});

describe('F1 create / read / list / update / delete', () => {
  it('creates a guest page, versioned, and reads it back', async () => {
    const createRes = await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Ada Lovelace',
      lect: { name: { en: 'Ada Lovelace' }, '@status': 'confirmed', '@rsvp_code': 'EAI-1' },
      tags: [],
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { page: { id: number; slug: string; page_type: string } }).page;
    expect(created.page_type).toBe('guest');
    expect(created.slug).toBe('ada-lovelace');

    // A create version was minted and linked.
    const row = await env.DB.prepare('SELECT current_page_version_id FROM draft_pages WHERE id = ?')
      .bind(created.id).first<{ current_page_version_id: number }>();
    expect(row?.current_page_version_id).toBeTruthy();
    const version = await env.DB.prepare('SELECT action FROM page_versions WHERE id = ?')
      .bind(row!.current_page_version_id).first<{ action: string }>();
    expect(version?.action).toBe('create');

    const readRes = await cmsApi('GET', `/__cms/pages/${created.id}`);
    expect(readRes.status).toBe(200);
    const read = (await readRes.json() as { page: { lect: Record<string, unknown> } }).page;
    expect((read.lect.name as { en: string }).en).toBe('Ada Lovelace');
    expect(read.lect['@status']).toBe('confirmed');
  });

  it('lists pages of an owned type with a search filter', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Grace Hopper' });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Alan Turing' });

    const allRes = await cmsApi('GET', '/__cms/pages?page_type=guest');
    const all = await allRes.json() as { total: number; pages: unknown[] };
    expect(all.total).toBe(2);

    const filtered = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=Grace')).json() as { total: number };
    expect(filtered.total).toBe(1);
  });

  it('rejects listing a type the plugin neither owns nor may read', async () => {
    const res = await cmsApi('GET', '/__cms/pages?page_type=article');
    expect(res.status).toBe(403);
  });

  it('filters a list by parent page id (guests of an event)', async () => {
    const event = (await (await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Gala' })).json() as { page: { id: number } }).page;
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Guest A', page_id: event.id });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Guest B', page_id: event.id });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Orphan' }); // no parent

    const res = await cmsApi('GET', `/__cms/pages?page_type=guest&page_id=${event.id}`);
    const body = await res.json() as { total: number };
    expect(body.total).toBe(2);
  });

  it('allows reading a declared readType but not writing it', async () => {
    // A contact page the events plugin does NOT own, inserted directly.
    await env.DB.prepare(
      "INSERT INTO draft_pages (name, slug, page_type, lect) VALUES (?, ?, 'contact', ?)",
    ).bind('Ada Lovelace', 'ada-lovelace', JSON.stringify({ first_name: { en: 'Ada' } })).run();
    const contact = await env.DB.prepare("SELECT id FROM draft_pages WHERE page_type = 'contact' LIMIT 1")
      .first<{ id: number }>();

    // Read is allowed (contact is a declared readType)…
    const readRes = await cmsApi('GET', `/__cms/pages/${contact!.id}`);
    expect(readRes.status).toBe(200);
    expect((await readRes.json() as { page: { name: string } }).page.name).toBe('Ada Lovelace');

    const listRes = await cmsApi('GET', '/__cms/pages?page_type=contact');
    expect(listRes.status).toBe(200);
    expect((await listRes.json() as { total: number }).total).toBe(1);

    // …but writes stay scoped to owned types.
    const createRes = await cmsApi('POST', '/__cms/pages', { page_type: 'contact', name: 'New' });
    expect(createRes.status).toBe(403);
    const updateRes = await cmsApi('PUT', `/__cms/pages/${contact!.id}`, { name: 'Hacked' });
    expect(updateRes.status).toBe(403);
  });

  it('partial-updates a page and mints an update version', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Edith', lect: { name: { en: 'Edith' }, '@status': 'invited' },
    })).json() as { page: { id: number } }).page;

    const updateRes = await cmsApi('PUT', `/__cms/pages/${created.id}`, {
      lect: { '@status': 'confirmed' },
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json() as { page: { lect: Record<string, unknown> } }).page;
    // Changed field applied, untouched field preserved (partial merge).
    expect(updated.lect['@status']).toBe('confirmed');
    expect((updated.lect.name as { en: string }).en).toBe('Edith');

    // Both a create and an update version exist (order-independent: the time-based
    // version id has a random component, so same-second inserts aren't ordered).
    const versions = await env.DB.prepare('SELECT action FROM page_versions WHERE page_id = ?')
      .bind(created.id).all<{ action: string }>();
    expect(versions.results.map((v) => v.action).sort()).toEqual(['create', 'update']);
  });

  it('soft-deletes a page to trash', async () => {
    const created = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest', name: 'Temp Guest',
    })).json() as { page: { id: number; uuid: string } }).page;

    const delRes = await cmsApi('DELETE', `/__cms/pages/${created.id}`);
    expect(delRes.status).toBe(200);

    const draft = await env.DB.prepare('SELECT id FROM draft_pages WHERE id = ?').bind(created.id).first();
    expect(draft).toBeNull();
    const trashed = await env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?').bind(created.uuid).first();
    expect(trashed).not.toBeNull();
  });

  it('deletes a mail list while its event remains live', async () => {
    const event = (await (await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Gala' })).json() as { page: { id: number } }).page;
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', page_id: event.id,
    })).json() as { page: { id: number } }).page;

    const deleteRes = await cmsApi('DELETE', `/__cms/pages/${list.id}`);
    expect(deleteRes.status).toBe(200);

    const trashed = await env.DB.prepare('SELECT page_id, source_page_id FROM trash_pages WHERE id = ?')
      .bind(list.id)
      .first<{ page_id: number | null; source_page_id: number | null }>();
    expect(trashed).toEqual({ page_id: null, source_page_id: event.id });
    expect(await env.DB.prepare('SELECT id FROM draft_pages WHERE id = ?').bind(event.id).first()).not.toBeNull();
  });
});

describe('F1 batch create', () => {
  it('creates many pages and reports per-item errors', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'G1' },
        { page_type: 'guest', name: 'G2' },
        { page_type: 'contact', name: 'Not allowed' }, // out of scope
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; errors: Array<{ index: number; error: string }> };
    expect(body.count).toBe(2);
    expect(body.errors).toEqual([{ index: 2, error: 'forbidden_page_type' }]);
  });

  it('allocates unique slugs and versions within one batch', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: [
        { page_type: 'guest', name: 'Same Name' },
        { page_type: 'guest', name: 'Same Name' },
      ],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; created: Array<{ id: number; slug: string }> };
    expect(body.count).toBe(2);
    expect(body.created.map((page) => page.slug)).toEqual(['same-name', 'same-name-2']);

    const rows = await env.DB.prepare(
      'SELECT slug, current_page_version_id FROM draft_pages WHERE id IN (?, ?) ORDER BY slug',
    ).bind(body.created[0].id, body.created[1].id).all<{ slug: string; current_page_version_id: number }>();
    expect(rows.results.map((row) => row.slug)).toEqual(['same-name', 'same-name-2']);
    expect(rows.results.every((row) => row.current_page_version_id)).toBe(true);

    const versions = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM page_versions WHERE page_id IN (?, ?)',
    ).bind(body.created[0].id, body.created[1].id).first<{ count: number }>();
    expect(versions?.count).toBe(2);
  });

  it('caps batch size to keep CMS work bounded', async () => {
    const res = await cmsApi('POST', '/__cms/pages/batch', {
      pages: Array.from({ length: 101 }, (_, index) => ({ page_type: 'guest', name: `G${index}` })),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'batch_too_large', max: 100 });
  });

  it('REPRO: creates an event with the real nested session blueprint + native start', async () => {
    // Re-register with the real event blueprint (nested session -> inputs).
    await env.DB.prepare('DELETE FROM plugins').run();
    __clearInjectedFetchers();
    clearManifestCache();
    clearConfigCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Events', url).run();
    const REAL_MANIFEST = {
      id: PLUGIN_ID, name: 'Events Suite', version: '1.0.0', hooks: ['delete'],
      contentTypes: { blueprint: { event: ['@type','@label','@rfid:switch','@show_guest_info:switch','@waiting_message','@kiosk_title','@checkin_require_login:switch','@virtual_event_link','@featured_image:picture','logo:picture','name:text/title','location:location','description:textarea',{ session: ['@checkin:switch','@type','@start:date/datetime','@duration','@capacity','name:text/title','location','description:textarea',{ inputs: ['@type','@name','@values'] }] }] } },
    };
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(REAL_MANIFEST);
        if (new URL(href).pathname.startsWith('/__plugin/hooks/')) return new Response('ok');
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const eventLect = {
      _type: 'event', kiosk_title: 'Welcome', name: { en: 'Launch' }, location: { en: 'Hall A' },
      description: { en: 'Desc' },
      session: [
        { _type: 'session', _weight: 0, checkin: 'yes', type: 'main', start: '2026-09-01T18:00', duration: '120', capacity: '100', name: { en: 'Main' }, location: { en: 'Hall' }, description: { en: '' }, inputs: [ { _type: 'inputs', _weight: 0, type: 'text', name: { en: 'Diet' }, values: '' } ] },
      ],
      _pointers: {},
    };
    const res = await cmsApi('POST', '/__cms/pages', {
      page_type: 'event', name: 'Copy of Launch', start: '2026-09-01T18:00', end: null, timezone: '+0800', page_id: null,
      lect: eventLect,
    });
    if (res.status !== 201) console.log('REPRO body:', res.status, await res.clone().text());
    expect(res.status).toBe(201);
  });
});
