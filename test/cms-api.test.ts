import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/plugins/registry';
import { clearConfigCache } from '../src/plugins/config';
import { restoreTrashedPages } from '../src/utils/admin-queries';
import { approvePageTypeAccess } from '../src/utils/plugin-page-types';

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
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
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

  it('requires admin approval before honoring delegated writeTypes', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();
    await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
    __clearInjectedFetchers();
    clearManifestCache();
    const url = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: PLUGIN_ID,
      name: 'Check-in Companion',
      version: '1.0.0',
      contentTypes: {
        blueprint: {
          event: ['@start', '@end', 'name:text/title', 'location'],
        },
        writeTypes: ['guest'],
        readTypes: ['mail_list'],
      },
    };
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Check-in', url).run();
    __injectPluginFetcher(url, {
      fetch: async (input: RequestInfo | URL): Promise<Response> => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (new URL(href).pathname === '/__plugin/manifest') return Response.json(manifest);
        return new Response('nf', { status: 404 });
      },
    } as unknown as Fetcher);

    const blocked = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Blocked Guest' });
    expect(blocked.status).toBe(403);

    await approvePageTypeAccess(env.DB, PLUGIN_ID, 'guest', 'write', 'admin@example.com');

    const createRes = await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Delegated Guest' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json() as { page: { id: number; page_type: string } }).page;
    expect(created.page_type).toBe('guest');

    const readRes = await cmsApi('GET', `/__cms/pages/${created.id}`);
    expect(readRes.status).toBe(200);
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

  it('uses Chinese variants and lect fields when plugins list pages with q', async () => {
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Su Sheng',
      lect: { name: { en: 'Su Sheng' }, zh_hans_name: '苏生', email: 'su@example.com' },
    });
    await cmsApi('POST', '/__cms/pages', {
      page_type: 'guest',
      name: 'Chan Tai Man',
      lect: { name: { en: 'Chan Tai Man' }, zh_hant_name: '陳大文', email: 'chan@example.com' },
    });

    const traditional = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=%E8%98%87')).json() as { total: number; pages: Array<{ name: string }> };
    expect(traditional.total).toBe(1);
    expect(traditional.pages[0].name).toBe('Su Sheng');

    const simplified = await (await cmsApi('GET', '/__cms/pages?page_type=guest&q=%E8%8B%8F')).json() as { total: number; pages: Array<{ name: string }> };
    expect(simplified.total).toBe(1);
    expect(simplified.pages[0].name).toBe('Su Sheng');
  });

  it('filters search results by multiple pointer values', async () => {
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳美玲', lect: { _pointers: { mail_list: '12' } } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳家豪', lect: { _pointers: { mail_list: '13' } } });
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: '陳外部', lect: { _pointers: { mail_list: '99' } } });

    const res = await cmsApi('GET', '/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_values=12,13&q=%E9%99%B3');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number; pages: Array<{ name: string }> };

    expect(body.total).toBe(2);
    expect(body.pages.map((page) => page.name).sort()).toEqual(['陳家豪', '陳美玲']);
  });

  it('rejects listing a type the plugin neither owns nor may read', async () => {
    const res = await cmsApi('GET', '/__cms/pages?page_type=article');
    expect(res.status).toBe(403);
  });

  it('rejects a delegated readType until an admin approves it', async () => {
    await env.DB.prepare(
      "INSERT INTO draft_pages (name, slug, page_type, lect) VALUES (?, ?, 'contact', ?)",
    ).bind('Ada Lovelace', 'ada-lovelace', JSON.stringify({ first_name: { en: 'Ada' } })).run();

    const res = await cmsApi('GET', '/__cms/pages?page_type=contact');
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
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
    await approvePageTypeAccess(env.DB, PLUGIN_ID, 'contact', 'read', 'admin@example.com');
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

  it('coerces an explicit null page_id to a null parent (not 0) so the FK holds', async () => {
    // Regression: `Number(null)` is 0, so a naive numeric coercion would bind
    // page_id=0 and violate the draft_pages self-FK. A null/empty parent must
    // store NULL. (Exposed by the events plugin "duplicate event" of a top-level
    // event, whose source page_id is null.)
    const res = await cmsApi('POST', '/__cms/pages', {
      page_type: 'event', name: 'Top-level event', page_id: null,
    });
    expect(res.status).toBe(201);
    const created = (await res.json() as { page: { id: number; page_id: number | null } }).page;
    expect(created.page_id).toBeNull();
  });

  it('bulk-clones a collection selected by lect pointer (not parent) with a transform', async () => {
    const sourceList = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const targetList = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP copy', lect: { _pointers: { event: '99' } },
    })).json() as { page: { id: number } }).page;

    // Guests reference the list ONLY by the mail_list pointer — page_id is left
    // null on purpose, so a parent-based selector would miss them entirely.
    for (const name of ['Jane', 'John', 'Jo']) {
      await cmsApi('POST', '/__cms/pages', {
        page_type: 'guest', name,
        lect: {
          email: `${name.toLowerCase()}@x.com`, status: 'confirmed',
          _pointers: { event: '7', mail_list: String(sourceList.id) },
          checkin: [{ status: 'checked-in', date: '2026-01-01' }],
        },
      });
    }

    const dup = await cmsApi('POST', '/__cms/pages/duplicate', {
      source_pointer_key: 'mail_list', source_pointer_value: String(sourceList.id),
      source_page_type: 'guest', target_page_id: targetList.id,
      lect: { status: 'to be invited', _pointers: { event: '99', mail_list: String(targetList.id) } },
      drop_lect: ['checkin'],
    });
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ count: 3, next_cursor: null, done: true });

    // Clones carry the transform and group under the target list by pointer.
    const cloned = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${targetList.id}`)).json() as {
      total: number; pages: Array<{ page_id: number; lect: Record<string, any> }>;
    };
    expect(cloned.total).toBe(3);
    for (const clone of cloned.pages) {
      expect(clone.page_id).toBe(targetList.id);                   // target parent set too
      expect(clone.lect.status).toBe('to be invited');            // override applied
      expect(clone.lect._pointers.event).toBe('99');               // repointed
      expect(clone.lect._pointers.mail_list).toBe(String(targetList.id));
      expect(clone.lect.checkin).toBeUndefined();                  // dropped
      expect(String(clone.lect.email)).toContain('@x.com');        // identity carried over
    }

    // The source guests are untouched.
    const sources = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${sourceList.id}`)).json() as { total: number };
    expect(sources.total).toBe(3);
  });

  it('rejects a duplicate into a page type the plugin does not own', async () => {
    const res = await cmsApi('POST', '/__cms/pages/duplicate', {
      source_pointer_key: 'mail_list', source_pointer_value: '1', source_page_type: 'contact', target_page_id: null,
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('rejects a duplicate with no source selector', async () => {
    const res = await cmsApi('POST', '/__cms/pages/duplicate', { source_page_type: 'guest' });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('selector_required');
  });

  it('bulk-trashes a collection selected by lect pointer (delete-children)', async () => {
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'VIP', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const other = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'Other', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;

    // Guests reference the list ONLY by the mail_list pointer (page_id null), so
    // a parent-based delete would miss them — the pointer selector must find them.
    for (const name of ['Jane', 'John', 'Jo']) {
      await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name, lect: { _pointers: { mail_list: String(list.id) } } });
    }
    // A guest under a different list must NOT be touched.
    await cmsApi('POST', '/__cms/pages', { page_type: 'guest', name: 'Keep', lect: { _pointers: { mail_list: String(other.id) } } });

    const del = await cmsApi('DELETE', '/__cms/pages/children', {
      pointer_key: 'mail_list', pointer_value: String(list.id), page_type: 'guest',
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ trashed: 3, done: true });

    // The list's guests are gone from drafts and now in trash.
    const remaining = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${list.id}`)).json() as { total: number };
    expect(remaining.total).toBe(0);
    const trashRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_pages WHERE page_type = 'guest'")
      .first<{ n: number }>();
    expect(trashRow?.n).toBe(3);

    // The other list's guest survives.
    const kept = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${other.id}`)).json() as { total: number };
    expect(kept.total).toBe(1);
  });

  it('rejects delete-children for a page type the plugin does not own', async () => {
    const res = await cmsApi('DELETE', '/__cms/pages/children', { pointer_key: 'mail_list', pointer_value: '1', page_type: 'contact' });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('forbidden_page_type');
  });

  it('rejects delete-children with both selectors (ambiguous)', async () => {
    const res = await cmsApi('DELETE', '/__cms/pages/children', {
      parent_page_id: 1, pointer_key: 'mail_list', pointer_value: '1', page_type: 'guest',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('ambiguous_selector');
  });
});

// Bulk restore-from-trash (the /admin/trash "Restore All" / "Restore Last Hour"
// controls). Exercises the set-based restoreTrashedPages helper against D1.
describe('bulk trash restore', () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM draft_pages WHERE page_type IN ('event','guest','mail_list')").run();
    await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list')").run();
  });

  async function trashGuestCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM trash_pages WHERE page_type = 'guest'").first<{ n: number }>();
    return row?.n ?? 0;
  }
  async function draftGuestCount(): Promise<number> {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_pages WHERE page_type = 'guest'").first<{ n: number }>();
    return row?.n ?? 0;
  }

  it('restores all trashed pages of a type back to draft, with version history', async () => {
    const list = (await (await cmsApi('POST', '/__cms/pages', {
      page_type: 'mail_list', name: 'L', lect: { _pointers: { event: '7' } },
    })).json() as { page: { id: number } }).page;
    const guestIds: number[] = [];
    for (const name of ['A', 'B', 'C']) {
      const g = (await (await cmsApi('POST', '/__cms/pages', {
        page_type: 'guest', name, lect: { _pointers: { mail_list: String(list.id) } },
      })).json() as { page: { id: number } }).page;
      guestIds.push(g.id);
    }
    await cmsApi('DELETE', '/__cms/pages/children', { pointer_key: 'mail_list', pointer_value: String(list.id), page_type: 'guest' });
    expect(await trashGuestCount()).toBe(3);
    expect(await draftGuestCount()).toBe(0);

    const restored = await restoreTrashedPages(env.DB, { pageType: 'guest' });
    expect(restored).toBe(3);

    // Back in drafts (same ids), gone from trash.
    expect(await draftGuestCount()).toBe(3);
    expect(await trashGuestCount()).toBe(0);
    const back = await (await cmsApi('GET', `/__cms/pages?page_type=guest&pointer_key=mail_list&pointer_value=${list.id}`)).json() as { total: number };
    expect(back.total).toBe(3);
    // The create version came back too (id preserved), so the editor can load it.
    const versions = await env.DB.prepare(`SELECT COUNT(*) AS n FROM page_versions WHERE page_id IN (${guestIds.map(() => '?').join(',')})`)
      .bind(...guestIds).first<{ n: number }>();
    expect(versions?.n).toBeGreaterThanOrEqual(3);
  });

  it('restores only the last hour when scoped, leaving older trash', async () => {
    // Two trash rows: one just now, one trashed two hours ago.
    await env.DB.prepare("INSERT INTO trash_pages (id, name, slug, page_type, lect, created_at) VALUES (?, 'Recent', 'recent', 'guest', '{}', datetime('now'))")
      .bind(900001).run();
    await env.DB.prepare("INSERT INTO trash_pages (id, name, slug, page_type, lect, created_at) VALUES (?, 'Old', 'old', 'guest', '{}', datetime('now', '-2 hours'))")
      .bind(900002).run();

    const restored = await restoreTrashedPages(env.DB, { pageType: 'guest', withinLastHour: true });
    expect(restored).toBe(1);

    // The recent row is restored; the old one stays in trash.
    expect(await draftGuestCount()).toBe(1);
    expect(await trashGuestCount()).toBe(1);
    const oldStill = await env.DB.prepare("SELECT name FROM trash_pages WHERE id = ?").bind(900002).first<{ name: string }>();
    expect(oldStill?.name).toBe('Old');
  });

  it('restores nothing (count 0) when the trash is empty', async () => {
    expect(await restoreTrashedPages(env.DB, {})).toBe(0);
  });
});
