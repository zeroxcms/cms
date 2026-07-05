import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearManifestCache, __injectPluginFetcher, __clearInjectedFetchers } from '../src/plugins/registry';
import { clearConfigCache } from '../src/plugins/config';
import { signJWT } from '../src/utils/jwt';
import {
  adjustCredits,
  chargeCredits,
  declaredCredits,
  getCreditBalance,
  loadCreditValues,
  saveCreditValues,
} from '../src/utils/credits';
import type { JWTPayload, PluginManifest } from '../src/types';

// Credit system: manifest-declared costs, admin-configured prices, charged by
// the host on page creates (both doors) and plugin-reported metered usage,
// with an append-only ledger.

const worker = (exports as unknown as { default: Fetcher }).default;
const testEnv = env as unknown as Record<string, unknown>;

const PLUGIN_ID = 'events';
const PLUGIN_SECRET = 'test-plugin-secret-value';
const ADMIN_ID = 1;
const PAYER_ID = 501;

const MANIFEST = {
  id: PLUGIN_ID,
  name: 'Events Suite',
  version: '1.0.0',
  contentTypes: {
    blueprint: {
      event: ['name:text/title'],
      guest: ['@email:email', 'name'],
      mail_list: ['*event'],
    },
  },
  credits: [
    { key: 'create_event', label: 'Create an event', charge: 'page_create', page_type: 'event', default: 100 },
    { key: 'create_guest_list', label: 'Create a guest list', charge: 'page_create', page_type: 'mail_list', default: 25 },
    // No default → free until an admin sets a price.
    { key: 'import_guest', label: 'Import a guest', charge: 'page_create', page_type: 'guest' },
    { key: 'send_edm', label: 'Send EDM email', charge: 'metered', unit: 'recipient', default: 2 },
    // Not an owned/approved type → dropped, or any plugin could tax another
    // plugin's content.
    { key: 'sabotage', label: 'Sabotage', charge: 'page_create', page_type: 'contact', default: 999 },
  ],
} as unknown as PluginManifest;

let ipCounter = 0;
let pluginUrl = '';

async function registerPlugin(): Promise<string> {
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
  return url;
}

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

/** Same call with the acting-user attribution header plugins echo back. */
function cmsApiAs(userId: number, method: string, path: string, body?: unknown): Promise<Response> {
  return cmsApi(method, path, body, { 'x-acting-user-id': String(userId) });
}

async function authCookie(role = 'admin'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: String(ADMIN_ID),
    email: 'admin@example.com',
    name: 'Admin User',
    role,
    type: 'access',
    exp: now + 900,
    iat: now,
  } as JWTPayload, env.JWT_SECRET);
  return `access_token=${token}`;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', await authCookie());
  headers.set('Sec-Fetch-Site', 'same-origin');
  ipCounter += 1;
  headers.set('CF-Connecting-IP', `10.8.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
  return worker.fetch(new Request(`http://localhost${path}`, { redirect: 'manual', ...init, headers }));
}

async function seedUser(id: number, credits: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, oauth_id, email, name, role, credits)
     VALUES (?, ?, ?, 'Test User', 'admin', ?)
     ON CONFLICT(id) DO UPDATE SET credits = excluded.credits`,
  ).bind(id, `test:${id}`, `user${id}@example.com`, credits).run();
}

async function balance(id: number): Promise<number | null> {
  return getCreditBalance(env, id);
}

async function ledgerRows(id: number): Promise<Array<{ delta: number; balance_after: number; action: string }>> {
  const rows = await env.DB.prepare(
    'SELECT delta, balance_after, action FROM credit_ledger WHERE user_id = ? ORDER BY id ASC',
  ).bind(id).all<{ delta: number; balance_after: number; action: string }>();
  return rows.results;
}

let savedSecret: unknown;

beforeEach(async () => {
  clearConfigCache();
  clearManifestCache();
  __clearInjectedFetchers();
  await env.DB.prepare('DELETE FROM plugins').run();
  await env.DB.prepare('DELETE FROM plugin_page_type_approvals').run();
  await env.DB.prepare('DELETE FROM credit_ledger').run();
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'plugin.credits.%' OR key LIKE 'plugin.limits.%'").run();
  await env.DB.prepare("DELETE FROM draft_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  await env.DB.prepare("DELETE FROM trash_pages WHERE page_type IN ('event','guest','mail_list','contact')").run();
  savedSecret = testEnv.PLUGIN_SECRET;
  testEnv.PLUGIN_SECRET = PLUGIN_SECRET;
  pluginUrl = await registerPlugin();
  await seedUser(ADMIN_ID, 0);
  await seedUser(PAYER_ID, 0);
});

describe('declaredCredits validation', () => {
  const allowed = new Set(['event', 'guest', 'mail_list']);

  it('keeps valid costs and drops ones on non-owned page types', () => {
    const defs = declaredCredits(MANIFEST, allowed);
    expect(defs.map((def) => def.key)).toEqual(['create_event', 'create_guest_list', 'import_guest', 'send_edm']);
  });

  it('normalizes charge kind, unit, and defaults', () => {
    const defs = declaredCredits(MANIFEST, allowed);
    expect(defs.find((def) => def.key === 'create_event')).toMatchObject({ charge: 'page_create', pageType: 'event', defaultValue: 100 });
    expect(defs.find((def) => def.key === 'import_guest')!.defaultValue).toBe(0);
    expect(defs.find((def) => def.key === 'send_edm')).toMatchObject({ charge: 'metered', pageType: null, unit: 'recipient', defaultValue: 2 });
  });

  it('drops malformed entries', () => {
    const manifest = {
      ...MANIFEST,
      credits: [
        { key: 'a', charge: 'weird', page_type: 'event' },
        { key: 'b', charge: 'page_create' },                    // missing page_type
        { key: 'c', charge: 'metered', default: -5 },           // negative default → 0
        { key: 'c', charge: 'metered', default: 9 },            // duplicate
        { key: 'BAD KEY', charge: 'metered' },
      ],
    } as unknown as PluginManifest;
    const defs = declaredCredits(manifest, allowed);
    expect(defs.map((def) => def.key)).toEqual(['c']);
    expect(defs[0].defaultValue).toBe(0);
  });
});

describe('chargeCredits / adjustCredits', () => {
  it('deducts atomically and writes a matching ledger row', async () => {
    await seedUser(PAYER_ID, 100);
    const result = await chargeCredits(env, {
      userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test',
    });
    expect(result).toMatchObject({ ok: true, balanceAfter: 70 });
    expect(await balance(PAYER_ID)).toBe(70);
    expect(await ledgerRows(PAYER_ID)).toEqual([{ delta: -30, balance_after: 70, action: 'test:spend' }]);
  });

  it('fails closed on insufficient balance, touching nothing', async () => {
    await seedUser(PAYER_ID, 10);
    const result = await chargeCredits(env, {
      userId: PAYER_ID, amount: 30, action: 'test:spend', createdBy: 'test',
    });
    expect(result).toMatchObject({ ok: false, error: 'insufficient_credits', balance: 10, required: 30 });
    expect(await balance(PAYER_ID)).toBe(10);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('reports an unknown user', async () => {
    const result = await chargeCredits(env, { userId: 999999, amount: 5, action: 'test:spend', createdBy: 'test' });
    expect(result).toMatchObject({ ok: false, error: 'unknown_user' });
  });

  it('grants unconditionally but never deducts below zero', async () => {
    await seedUser(PAYER_ID, 5);
    const grant = await adjustCredits(env, { userId: PAYER_ID, delta: 50, action: 'admin:adjust', createdBy: '1' });
    expect(grant).toMatchObject({ ok: true, balanceAfter: 55 });

    const overdraw = await adjustCredits(env, { userId: PAYER_ID, delta: -100, action: 'admin:adjust', createdBy: '1' });
    expect(overdraw).toMatchObject({ ok: false, error: 'insufficient_credits' });
    expect(await balance(PAYER_ID)).toBe(55);
  });
});

describe('/__cms page-create charging', () => {
  it('charges the acting user with the declaring plugin key as the action', async () => {
    await seedUser(PAYER_ID, 150);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'E1' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(50);
    expect(await ledgerRows(PAYER_ID)).toEqual([
      { delta: -100, balance_after: 50, action: 'events:create_event' },
    ]);
  });

  it('rejects with 402 and creates nothing when the balance is short', async () => {
    await seedUser(PAYER_ID, 99);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'E1' });
    expect(res.status).toBe(402);
    const body = await res.json() as { error: string; credit: { required: number; balance: number } };
    expect(body.error).toBe('insufficient_credits');
    expect(body.credit).toEqual({ required: 100, balance: 99 });

    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_pages WHERE page_type = 'event'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(await balance(PAYER_ID)).toBe(99);
  });

  it('does not charge server-to-server creates with no acting user', async () => {
    const res = await cmsApi('POST', '/__cms/pages', { page_type: 'event', name: 'Public flow' });
    expect(res.status).toBe(201);
    expect(await ledgerRows(PAYER_ID)).toEqual([]);
  });

  it('honors an admin-configured price over the manifest default', async () => {
    await saveCreditValues(env, PLUGIN_ID, { create_event: 10 });
    await seedUser(PAYER_ID, 15);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'event', name: 'Cheap' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(5);
  });

  it('charges a batch once, all-or-nothing', async () => {
    await seedUser(PAYER_ID, 60);
    const ok = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages/batch', {
      pages: [{ page_type: 'mail_list', name: 'L1' }, { page_type: 'mail_list', name: 'L2' }],
    });
    expect(ok.status).toBe(200);
    expect(await balance(PAYER_ID)).toBe(10);
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: -50, action: 'page_create:batch' });

    // Third + fourth list cost 50 but only 10 remains → whole batch rejected.
    const blocked = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages/batch', {
      pages: [{ page_type: 'mail_list', name: 'L3' }, { page_type: 'mail_list', name: 'L4' }],
    });
    expect(blocked.status).toBe(402);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_pages WHERE page_type = 'mail_list'")
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('creates free page types without touching the ledger', async () => {
    await seedUser(PAYER_ID, 10);
    // import_guest declares no default → guests are free until priced.
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/pages', { page_type: 'guest', name: 'G1' });
    expect(res.status).toBe(201);
    expect(await balance(PAYER_ID)).toBe(10);
  });
});

describe('/__cms credits endpoints', () => {
  it('GET /credits reports prices and the acting user balance', async () => {
    await seedUser(PAYER_ID, 320);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits');
    expect(res.status).toBe(200);
    const body = await res.json() as { balance: number; credits: Array<Record<string, unknown>> };
    expect(body.balance).toBe(320);
    expect(body.credits.map((credit) => credit.key)).toEqual(['create_event', 'create_guest_list', 'import_guest', 'send_edm']);
    expect(body.credits.find((credit) => credit.key === 'send_edm')).toMatchObject({ charge: 'metered', unit: 'recipient', value: 2 });
  });

  it('GET /credits/quote prices a quantity without deducting', async () => {
    await seedUser(PAYER_ID, 100);
    const res = await cmsApiAs(PAYER_ID, 'GET', '/__cms/credits/quote?key=send_edm&quantity=60');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ unit_cost: 2, quantity: 60, total: 120, balance: 100, affordable: false });
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('POST /credits/charge deducts metered usage', async () => {
    await seedUser(PAYER_ID, 100);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', {
      key: 'send_edm', quantity: 30, entity_type: 'edm', entity_id: 42, note: 'Launch blast',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, charged: 60, balance: 40 });
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: -60, action: 'events:send_edm' });
  });

  it('rejects charges for undeclared keys, non-metered keys, and missing acting user', async () => {
    await seedUser(PAYER_ID, 100);
    expect((await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'made_up' })).status).toBe(400);
    expect((await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'create_event' })).status).toBe(400);
    expect((await cmsApi('POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 1 })).status).toBe(400);
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('returns 402 with the shortfall on insufficient balance', async () => {
    await seedUser(PAYER_ID, 5);
    const res = await cmsApiAs(PAYER_ID, 'POST', '/__cms/credits/charge', { key: 'send_edm', quantity: 10 });
    expect(res.status).toBe(402);
    expect((await res.json() as { credit: unknown }).credit).toEqual({ required: 20, balance: 5 });
  });
});

describe('admin editor charging', () => {
  it('charges the signed-in editor on POST /admin/pages', async () => {
    await seedUser(ADMIN_ID, 250);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event-credit', page_type: 'event' }),
    });
    expect(res.status).toBe(302);
    expect(await balance(ADMIN_ID)).toBe(150);
    expect((await ledgerRows(ADMIN_ID))[0]).toMatchObject({ delta: -100, action: 'events:create_event' });
  });

  it('re-renders with an error and charges nothing when the balance is short', async () => {
    await seedUser(ADMIN_ID, 40);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'Editor Event', slug: 'editor-event-poor', page_type: 'event' }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Not enough credits');
    expect(await balance(ADMIN_ID)).toBe(40);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM draft_pages WHERE page_type = 'event'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('never charges for a request that fails validation', async () => {
    await seedUser(ADMIN_ID, 250);
    const res = await adminFetch('/admin/pages', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: '', slug: '', page_type: 'event' }),
    });
    expect(res.status).toBe(422);
    expect(await balance(ADMIN_ID)).toBe(250);
  });
});

describe('admin credit management', () => {
  it('grants credits with a note and logs the adjustment', async () => {
    const res = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '500', note: 'Starter balance' }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('flash=');
    expect(await balance(PAYER_ID)).toBe(500);
    expect((await ledgerRows(PAYER_ID))[0]).toMatchObject({ delta: 500, action: 'admin:adjust' });
  });

  it('requires a note and refuses deductions below zero', async () => {
    await seedUser(PAYER_ID, 100);
    const noNote = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '50', note: '' }),
    });
    expect(noNote.headers.get('location')).toContain('error=');

    const overdraw = await adminFetch(`/admin/users/${PAYER_ID}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '-500', note: 'Clawback' }),
    });
    expect(overdraw.headers.get('location')).toContain('error=');
    expect(await balance(PAYER_ID)).toBe(100);
  });

  it('shows the balance and ledger on the user edit page', async () => {
    await seedUser(PAYER_ID, 75);
    await chargeCredits(env, { userId: PAYER_ID, amount: 25, action: 'events:create_guest_list', createdBy: 'test' });
    const res = await adminFetch(`/admin/users/${PAYER_ID}/edit`);
    expect(res.status).toBe(200);
    // The admin shell renders liquid client-side; assert on the embedded
    // view data rather than the final markup.
    const html = await res.text();
    expect(html).toContain('creditBalance');
    expect(html).toContain('events:create_guest_list');
  });
});

describe('profile and plugins-manage pages', () => {
  it('shows the balance and recent activity on the profile', async () => {
    await seedUser(ADMIN_ID, 180);
    await chargeCredits(env, { userId: ADMIN_ID, amount: 100, action: 'events:create_event', createdBy: '1' });
    const res = await adminFetch('/admin/profile');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('creditBalance');
    expect(html).toContain('events:create_event');
  });

  it('lists and saves declared prices on the plugin credits page', async () => {
    const row = await env.DB.prepare('SELECT id FROM plugins WHERE url = ?').bind(pluginUrl).first<{ id: number }>();
    const page = await adminFetch(`/admin/plugins-manage/${row!.id}/credits`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Create an event');
    expect(html).not.toContain('sabotage');

    const save = await adminFetch(`/admin/plugins-manage/${row!.id}/credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value_create_event: '10', value_send_edm: '0', value_sabotage: '5', value_bogus: '1' }),
    });
    expect(save.status).toBe(302);
    expect(await loadCreditValues(env, PLUGIN_ID)).toEqual({ create_event: 10, send_edm: 0 });
  });
});
