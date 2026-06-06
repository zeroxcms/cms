import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashToken, signJWT } from '../src/utils/jwt';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;

interface RouteCase {
  name: string;
  method?: string;
  path: string;
  body?: BodyInit;
  headers?: HeadersInit;
  authenticated?: boolean;
  expectedStatus: number;
  location?: string | RegExp;
  json?: unknown;
}

const basePageLect = JSON.stringify({
  _type: 'default',
  name: { en: 'About' },
  body: { en: 'About body' },
});

beforeEach(async () => {
  vi.unstubAllGlobals();
  await resetData();
  await seedBaseData();
});

describe('app shell routes', () => {
  it.each<RouteCase>([
    { name: 'GET /media/* without bucket', path: '/media/missing.png', expectedStatus: 404 },
    { name: 'GET /login', path: '/login', expectedStatus: 302, location: '/auth/login' },
    { name: 'GET /favicon.ico', path: '/favicon.ico', expectedStatus: 204 },
    { name: 'GET /', path: '/', expectedStatus: 302, location: '/auth/login' },
    { name: 'notFound', path: '/missing', expectedStatus: 404 },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('redirects non-canonical hosts before route handling', async () => {
    const response = await fetchWorker('/admin', { host: 'https://old.example.com' });

    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe('https://cms.eventuai.com/admin');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('rejects cross-origin mutations before protected routes run', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('Forbidden');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});

describe('auth routes', () => {
  it.each<RouteCase>([
    { name: 'GET /auth/login', path: '/auth/login', expectedStatus: 200 },
    { name: 'GET /auth/start', path: '/auth/start?provider=eventuai', expectedStatus: 302, location: /^https:\/\/id\.eventuai\.com\/oauth\/authorize/ },
    { name: 'GET /auth/callback missing params', path: '/auth/callback', expectedStatus: 302, location: '/auth/login?error=missing_params' },
    { name: 'GET /auth/logout', path: '/auth/logout', expectedStatus: 302, location: '/auth/login' },
    { name: 'POST /auth/refresh without token', method: 'POST', path: '/auth/refresh', expectedStatus: 401, json: { error: 'no_refresh_token' } },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('GET /auth/callback exchanges a valid OAuth response, upserts the user, and creates a session', async () => {
    const start = await fetchWorker('/auth/start?provider=eventuai');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state');
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://id.eventuai.com/oauth/token') {
        return Response.json({ access_token: 'provider-token' });
      }
      if (url === 'https://id.eventuai.com/oauth/userinfo') {
        return Response.json({
          sub: 'eventuai-user',
          email: 'eventuai@example.com',
          preferred_username: 'Eventuai User',
          roles: ['editor'],
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state ?? '')}`, {
      headers: { Cookie: `oauth_state=${stateCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(callback.headers.get('Set-Cookie')).toContain('access_token=');
    expect(await env.DB.prepare('SELECT role FROM users WHERE oauth_id = ?')
      .bind('eventuai:eventuai-user')
      .first<{ role: string }>()).toEqual({ role: 'editor' });
    expect((await env.DB.prepare('SELECT id FROM sessions').all()).results).toHaveLength(1);
  });

  it('POST /auth/refresh rotates a valid refresh token session', async () => {
    const jti = 'refresh-token-id';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${token}` },
    });
    const body = await response.json<{ ok: boolean; expires_in: number }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, expires_in: 900 });
    expect(response.headers.get('Set-Cookie')).toContain('access_token=');
    expect(response.headers.get('Set-Cookie')).toContain('refresh_token=');
  });
});

describe('admin routes', () => {
  it.each<RouteCase>([
    { name: 'GET /admin', path: '/admin', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/list/:pageType', path: '/admin/pages/list/default', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/search/:pageType', path: '/admin/pages/search/default?search=About', authenticated: true, expectedStatus: 302, location: '/admin/advanced-search/default?operator=AND&pagesize=20&sort=updated_at&order=DESC&search1=About&path1=' },
    { name: 'GET /admin/pages/create_by_type/:pageType', path: '/admin/pages/create_by_type/default', authenticated: true, expectedStatus: 302, location: '/admin/pages/new?page_type=default' },
    { name: 'POST /admin/pages/new_post/:pageType', method: 'POST', path: '/admin/pages/new_post/default', body: form({ name: 'Quick Page', slug: 'quick-page' }), authenticated: true, expectedStatus: 302, location: /^\/admin\/pages\/\d+\/edit$/ },
    { name: 'GET /admin/pages/import/:pageType', path: '/admin/pages/import/default', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/pages/import/:pageType', method: 'POST', path: '/admin/pages/import/default', body: form({ items: JSON.stringify([{ name: 'Imported', slug: 'imported', lect: { name: { en: 'Imported' } } }]) }), authenticated: true, expectedStatus: 302, location: '/admin/pages/list/default?flash=1+item(s)+imported' },
    { name: 'GET /admin/pages/import-v2/:pageType', path: '/admin/pages/import-v2/default', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/new', path: '/admin/pages/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/pages', method: 'POST', path: '/admin/pages', body: form({ name: 'Created', slug: 'created', page_type: 'default' }), authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+created+successfully' },
    { name: 'GET /admin/pages/:id/edit', path: '/admin/pages/101/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/pages/:id/weight', method: 'POST', path: '/admin/pages/101/weight', body: form({ weight: '9', return_to: '/admin/pages/list/default' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/list/default?flash=Draft+weight+updated' },
    { name: 'POST /admin/pages/:id', method: 'POST', path: '/admin/pages/101', body: form({ name: 'About Updated', slug: 'about-updated', page_type: 'default', weight: '3' }), authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+updated+successfully' },
    { name: 'POST /admin/pages/:id/publish', method: 'POST', path: '/admin/pages/101/publish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+published+successfully' },
    { name: 'POST /admin/pages/:id/unpublish', method: 'POST', path: '/admin/pages/101/unpublish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+unpublished' },
    { name: 'POST /admin/pages/:id/delete', method: 'POST', path: '/admin/pages/101/delete', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+moved+to+trash' },
    { name: 'GET /admin/trash', path: '/admin/trash', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/trash/:id/restore', method: 'POST', path: '/admin/trash/201/restore', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+restored+to+draft' },
    { name: 'POST /admin/trash/:id/delete', method: 'POST', path: '/admin/trash/201/delete', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+permanently+deleted' },
    { name: 'GET /admin/api/pages/:type', path: '/admin/api/pages/default', authenticated: true, expectedStatus: 200, json: [{ page: 101, name: 'About' }] },
    { name: 'GET /admin/api/tags/:type', path: '/admin/api/tags/categories', authenticated: true, expectedStatus: 200, json: [{ value: 301, label: 'News' }, { value: 302, label: 'Updates' }] },
    { name: 'POST /admin/api/page/:pageId/tag/:tagId', method: 'POST', path: '/admin/api/page/101/tag/301', authenticated: true, expectedStatus: 200 },
    { name: 'DELETE /admin/api/page/remove/page_tag/:id', method: 'DELETE', path: '/admin/api/page/remove/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'DELETE /admin/api/page_tag/:id', method: 'DELETE', path: '/admin/api/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'POST /admin/upload', method: 'POST', path: '/admin/upload', body: form({ dir: 'uploads' }), authenticated: true, expectedStatus: 200, json: { success: true, files: [] } },
    { name: 'GET /admin/tag-types', path: '/admin/tag-types', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/tag-types/new', path: '/admin/tag-types/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tag-types', method: 'POST', path: '/admin/tag-types', body: form({ name: 'Topics', slug: 'topics' }), authenticated: true, expectedStatus: 302, location: '/admin/tag-types' },
    { name: 'GET /admin/tag-types/:id/edit', path: '/admin/tag-types/300/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tag-types/:id', method: 'POST', path: '/admin/tag-types/300', body: form({ name: 'Categories', slug: 'categories' }), authenticated: true, expectedStatus: 302, location: '/admin/tag-types' },
    { name: 'POST /admin/tag-types/:id/delete', method: 'POST', path: '/admin/tag-types/300/delete', authenticated: true, expectedStatus: 302, location: '/admin/tag-types' },
    { name: 'GET /admin/tags', path: '/admin/tags', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/tags/new', path: '/admin/tags/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags', method: 'POST', path: '/admin/tags', body: form({ name: 'Fresh Tag', slug: 'fresh-tag', tag_type_id: '300' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'GET /admin/tags/:id/edit', path: '/admin/tags/301/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags/:id', method: 'POST', path: '/admin/tags/301', body: form({ name: 'News Updated', slug: 'news-updated', tag_type_id: '300' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'POST /admin/tags/:id/delete', method: 'POST', path: '/admin/tags/301/delete', authenticated: true, expectedStatus: 302, location: '/admin/tags' },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('POST /admin/pages/import-v2/:pageType shows a confirmation page before importing', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default', {
      method: 'POST',
      body: form({ csv: 'name,slug\nFresh CSV,fresh-csv\nAbout,about' }),
      headers: { Cookie: await authCookie() },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Confirm Import');
    expect(html).toContain('New + Add Missing Fields');
    expect(html).toContain('Treat All Rows As New Pages');
    expect(html).toContain('Fresh CSV');
    expect(html).toContain('#101 About');
    expect(await env.DB.prepare('SELECT id FROM draft_pages WHERE slug = ?')
      .bind('fresh-csv')
      .first<{ id: number }>()).toBeNull();
  });

  it('POST /admin/pages/import-v2/:pageType/confirm imports confirmed CSV rows', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({ action: 'new-overwrite', csv: 'name,slug\nFresh CSV,fresh-csv\nAbout Updated,about' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=1+created,+1+updated,+0+skipped');
    expect(await env.DB.prepare('SELECT name, page_type FROM draft_pages WHERE slug = ?')
      .bind('fresh-csv')
      .first<{ name: string; page_type: string }>()).toEqual({ name: 'Fresh CSV', page_type: 'default' });
    expect(await env.DB.prepare('SELECT name FROM draft_pages WHERE id = ?')
      .bind(101)
      .first<{ name: string }>()).toEqual({ name: 'About Updated' });
  });

  it('POST /admin/pages/import-v2/:pageType/confirm can import new rows only', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({ action: 'new', csv: 'name,slug\nFresh CSV,fresh-csv\nAbout Updated,about' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=1+created,+0+updated,+1+skipped');
    expect(await env.DB.prepare('SELECT name FROM draft_pages WHERE slug = ?')
      .bind('fresh-csv')
      .first<{ name: string }>()).toEqual({ name: 'Fresh CSV' });
    expect(await env.DB.prepare('SELECT name FROM draft_pages WHERE id = ?')
      .bind(101)
      .first<{ name: string }>()).toEqual({ name: 'About' });
  });

  it('POST /admin/pages/import-v2/:pageType/confirm can append missing fields without replacing existing values', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({ action: 'new-append', csv: 'name,slug,body,link\nAbout Updated,about,Replacement body,Homepage' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=0+created,+1+updated,+0+skipped');
    const page = await env.DB.prepare('SELECT name, lect FROM draft_pages WHERE id = ?')
      .bind(101)
      .first<{ name: string; lect: string }>();
    const lect = JSON.parse(page?.lect ?? '{}') as { body?: { en?: string }; link?: { en?: string } };
    expect(page?.name).toBe('About');
    expect(lect.body?.en).toBe('About body');
    expect(lect.link?.en).toBe('Homepage');
  });

  it('POST /admin/pages/import-v2/:pageType/confirm can treat matching rows as new pages', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({ action: 'force-new', csv: 'name,slug\nAbout Copy,about' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=1+created,+0+updated,+0+skipped');
    expect((await env.DB.prepare('SELECT id FROM draft_pages WHERE slug = ? ORDER BY id ASC')
      .bind('about')
      .all()).results).toHaveLength(2);
  });

  it('redirects anonymous admin requests to login', async () => {
    const response = await fetchWorker('/admin');

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/auth/login');
  });

  it('returns JSON for unauthenticated upload requests', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(401);
    expect(response.headers.get('X-CMS-Error')).toBe('authentication-required');
    expect(await response.json()).toEqual({ success: false, error: 'Authentication required' });
  });

  it('returns JSON for upload requests rejected by origin checks', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Origin: 'https://evil.example.com',
      },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('origin-is-not-allowed');
    expect(await response.json()).toEqual({ success: false, error: 'Origin is not allowed' });
  });

  it('returns JSON for forbidden upload requests', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Cookie: await authCookie('viewer'),
      },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('editor-role-required');
    expect(await response.json()).toEqual({ success: false, error: 'Editor role required' });
  });

  it('POST /admin/api/page/:pageId/tag/:tagId reports duplicate tag links', async () => {
    await env.DB.prepare('INSERT INTO draft_page_tags (id, page_id, tag_id) VALUES (?, ?, ?)')
      .bind(402, 101, 301)
      .run();

    const response = await fetchWorker('/admin/api/page/101/tag/301', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: 'ADD_PAGE_TAG',
      payload: { success: false, message: 'tag exist', id: 402 },
    });
  });

  it('POST /admin/upload stores media in R2 and records metadata', async () => {
    const body = new FormData();
    body.append('dir', 'pictures');
    body.append('file', new File(['tiny image'], 'avatar.png', { type: 'image/png' }));

    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });
    const payload = await response.json<{ success: boolean; files: string[] }>();

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatch(/^\/media\/pictures\/\d{4}\/\d{1,2}\/\d{1,2}\/.+-avatar\.png$/);

    const media = await env.DB.prepare('SELECT key, url, filename, content_type, size FROM media_files WHERE url = ?')
      .bind(payload.files[0])
      .first<{ key: string; url: string; filename: string; content_type: string; size: number }>();
    expect(media).toMatchObject({
      url: payload.files[0],
      filename: 'avatar.png',
      content_type: 'image/png',
      size: 10,
    });
  });

  it('GET /media-preview/* serves uploaded media for editor thumbnails', async () => {
    const body = new FormData();
    body.append('dir', 'pictures');
    body.append('file', new File(['tiny image'], 'avatar.png', { type: 'image/png' }));

    const upload = await fetchWorker('/admin/upload', {
      method: 'POST',
      body,
      headers: { Cookie: await authCookie() },
    });
    const payload = await upload.json<{ files: string[] }>();
    const previewPath = payload.files[0].replace(/^\/media\//, '/media-preview/');

    const response = await fetchWorker(previewPath);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe('tiny image');
  });
});

async function expectRoute(route: RouteCase): Promise<Response> {
  const headers = new Headers(route.headers);
  if (route.authenticated) headers.set('Cookie', await authCookie());
  const response = await fetchWorker(route.path, {
    method: route.method,
    body: route.body,
    headers,
  });

  expect(response.status).toBe(route.expectedStatus);
  if (route.location) {
    const location = response.headers.get('Location');
    if (typeof route.location === 'string') expect(location).toBe(route.location);
    else expect(location).toMatch(route.location);
  }
  if (route.json !== undefined) {
    expect(await response.json()).toEqual(route.json);
  }
  expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  return response;
}

async function fetchWorker(
  path: string,
  init: RequestInit & { host?: string } = {},
): Promise<Response> {
  const host = init.host ?? 'http://localhost';
  const request = new IncomingRequest(new URL(path, host), {
    redirect: 'manual',
    ...init,
  });
  return worker.fetch(request);
}

async function authCookie(role = 'admin'): Promise<string> {
  return `access_token=${await signTestToken({ role })}`;
}

async function signTestToken(overrides: Partial<JWTPayload> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJWT({
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access',
    exp: now + 900,
    iat: now,
    ...overrides,
  }, env.JWT_SECRET);
}

function form(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

function cookieValue(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? '';
}

async function resetData(): Promise<void> {
  const tables = [
    'draft_page_tags',
    'live_page_tags',
    'trash_page_tags',
    'page_versions',
    'media_files',
    'draft_pages',
    'live_pages',
    'trash_pages',
    'tags',
    'tag_types',
    'sessions',
    'users',
  ];
  for (const table of tables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

async function seedBaseData(): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(1, 'eventuai:admin', 'admin@example.com', 'Admin User', '', 'admin')
    .run();

  await env.DB.prepare('INSERT INTO tag_types (id, name, slug) VALUES (?, ?, ?)')
    .bind(300, 'Categories', 'categories')
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, tag_type_id, lect) VALUES (?, ?, ?, ?, ?)')
    .bind(301, 'News', 'news', 300, JSON.stringify({ name: { en: 'News' } }))
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, tag_type_id, lect) VALUES (?, ?, ?, ?, ?)')
    .bind(302, 'Updates', 'updates', 300, JSON.stringify({ name: { en: 'Updates' } }))
    .run();

  await env.DB.prepare(
    `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, current_page_version_id, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(101, 'page-uuid-101', 'About', 'about', 5, 'default', 501, basePageLect, 1, '1')
    .run();
  await env.DB.prepare(
    'INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)',
  )
    .bind(501, 101, basePageLect, 'create')
    .run();
  await env.DB.prepare(
    `INSERT INTO live_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(102, 'page-uuid-101', 'About', 'about', 5, 'default', basePageLect, 1, '1')
    .run();
  await env.DB.prepare(
    `INSERT INTO trash_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(201, 'trash-uuid-201', 'Old Page', 'old-page', 5, 'default', basePageLect, 1, '1')
    .run();
  await env.DB.prepare('INSERT INTO draft_page_tags (id, page_id, tag_id) VALUES (?, ?, ?)')
    .bind(401, 101, 302)
    .run();
}
