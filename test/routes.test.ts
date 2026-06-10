import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cmsConfig } from '../src/cms-config';
import { hashToken, signJWT } from '../src/utils/jwt';
import { blueprintToLect, stringifyLect } from '../src/utils/lect';
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

function localizedFixture(base: string): Record<string, string> {
  return Object.fromEntries(cmsConfig.languages.map((language) => [
    language,
    language === cmsConfig.defaultLanguage ? base : `${base} ${language}`,
  ]));
}

function defaultLanguageFixture(base: string): Record<string, string> {
  return Object.fromEntries(cmsConfig.languages.map((language) => [
    language,
    language === cmsConfig.defaultLanguage ? base : '',
  ]));
}

const basePageLectObject = blueprintToLect('default', cmsConfig.blueprint, cmsConfig.defaultLanguage);
basePageLectObject.name = localizedFixture('About');
basePageLectObject.body = localizedFixture('About body');
basePageLectObject.link = {
  [cmsConfig.defaultLanguage]: '',
  label: localizedFixture('Click Now'),
  url: defaultLanguageFixture('https://example.com'),
};
const basePageLect = stringifyLect(basePageLectObject);

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

  it('rejects mutations with no browser origin signals (fail closed)', async () => {
    // Raw request without Origin, Referer or Sec-Fetch-Site — e.g. a script
    // replaying stolen cookies. Must be rejected even with valid auth.
    const response = await worker.fetch(new IncomingRequest('http://localhost/admin/pages', {
      method: 'POST',
      redirect: 'manual',
      body: form({ name: 'Sneaky', slug: 'sneaky', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    }));

    expect(response.status).toBe(403);
  });

  it('allows mutations with an explicit cross-site Sec-Fetch-Site of none (address bar)', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Direct', slug: 'direct', page_type: 'default' }),
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'none' },
    });

    expect(response.status).toBe(302);
  });

  it('rejects mutations marked cross-site by Sec-Fetch-Site', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'cross-site' },
    });

    expect(response.status).toBe(403);
  });

  it('issues __Host- prefixed auth cookies on https', async () => {
    const jti = 'host-cookie-refresh';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      host: 'https://cms.eventuai.com',
      headers: { Cookie: `refresh_token=${token}` },
    });
    const setCookies = response.headers.getSetCookie().join('\n');

    expect(response.status).toBe(200);
    expect(setCookies).toContain('__Host-access_token=');
    expect(setCookies).toContain('__Host-refresh_token=');
    // Legacy unprefixed cookie still accepted (read fallback) but replaced.
    expect(setCookies).toMatch(/(^|\n)access_token=;/);
  });
});

describe('auth routes', () => {
  it.each<RouteCase>([
    { name: 'GET /auth/login', path: '/auth/login', expectedStatus: 200 },
    { name: 'GET /auth/start', path: '/auth/start?provider=eventuai', expectedStatus: 302, location: /^https:\/\/id\.eventuai\.com\/oauth\/authorize/ },
    { name: 'GET /auth/callback missing params', path: '/auth/callback', expectedStatus: 302, location: '/auth/login?error=missing_params' },
    { name: 'POST /auth/logout', method: 'POST', path: '/auth/logout', expectedStatus: 302, location: '/auth/login' },
    { name: 'GET /auth/logout is rejected', path: '/auth/logout', expectedStatus: 405 },
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
    { name: 'POST /admin/upload', method: 'POST', path: '/admin/upload', body: form({ dir: 'uploads' }), authenticated: true, expectedStatus: 200, json: { success: true, files: [], errors: [] } },
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

  it('POST /admin/pages/:id/publish writes published content to PUBLISHED_DB only', async () => {
    await env.PUBLISHED_DB.prepare('DELETE FROM live_page_tags').run();
    await env.PUBLISHED_DB.prepare('DELETE FROM live_pages').run();

    const response = await fetchWorker('/admin/pages/101/publish', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.PUBLISHED_DB.prepare('SELECT name, slug, page_type FROM live_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ name: string; slug: string; page_type: string }>()).toEqual({
        name: 'About',
        slug: 'about',
        page_type: 'default',
      });
    expect(await env.PUBLISHED_DB.prepare(
      `SELECT lpt.tag_id
       FROM live_page_tags lpt
       JOIN live_pages lp ON lp.id = lpt.page_id
       WHERE lp.uuid = ?`,
    )
      .bind('page-uuid-101')
      .first<{ tag_id: number }>()).toEqual({ tag_id: 302 });
  });

  it('POST /admin/pages/:id/unpublish removes content from PUBLISHED_DB', async () => {
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM live_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).not.toBeNull();

    const response = await fetchWorker('/admin/pages/101/unpublish', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.PUBLISHED_DB.prepare('SELECT id FROM live_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number }>()).toBeNull();
  });

  it('CMS DB migration does not create live tables', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('live_pages', 'live_page_tags')
       ORDER BY name`,
    ).all<{ name: string }>();

    expect(tables.results).toEqual([]);
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

  it('POST /admin/pages/import-v2/:pageType/confirm bulk creates page versions', async () => {
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({ action: 'new', csv: 'name,slug\nBulk One,bulk-one\nBulk Two,bulk-two\nBulk Three,bulk-three' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=3+created,+0+updated,+0+skipped');

    const pages = await env.DB.prepare(
      `SELECT id, current_page_version_id
       FROM draft_pages
       WHERE slug IN (?, ?, ?)
       ORDER BY slug ASC`,
    )
      .bind('bulk-one', 'bulk-three', 'bulk-two')
      .all<{ id: number; current_page_version_id: number }>();
    const pageIds = pages.results.map((page) => page.id);
    const versions = await env.DB.prepare(
      `SELECT id, page_id, action
       FROM page_versions
       WHERE page_id IN (?, ?, ?)
       ORDER BY page_id ASC`,
    )
      .bind(...pageIds)
      .all<{ id: number; page_id: number; action: string }>();
    const versionByPage = new Map(versions.results.map((version) => [version.page_id, version]));

    expect(pages.results).toHaveLength(3);
    expect(versions.results).toHaveLength(3);
    for (const page of pages.results) {
      expect(versionByPage.get(page.id)).toMatchObject({
        id: page.current_page_version_id,
        action: 'import',
      });
    }
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
    const lect = JSON.parse(page?.lect ?? '{}') as { body?: Record<string, string>; link?: Record<string, string> };
    expect(page?.name).toBe('About');
    expect(lect.body?.[cmsConfig.defaultLanguage]).toBe('About body');
    expect(lect.link?.[cmsConfig.defaultLanguage]).toBe('Homepage');
  });

  it('GET /admin/advanced-search-export/:pageType exports localized fields for every language', async () => {
    const response = await fetchWorker('/admin/advanced-search-export/default?operator=AND&sort=updated_at&order=DESC&search1=About&path1=', {
      headers: { Cookie: await authCookie() },
    });
    const csv = await response.text();
    const [header] = csv.replace(/^\uFEFF/, '').split('\n');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    expect(header).toContain(cmsConfig.languages.map((language) => `name.${language}`).join(','));
    expect(header).toContain(cmsConfig.languages.map((language) => `body.${language}`).join(','));
    for (const language of cmsConfig.languages) {
      expect(header).toContain(`link.label.${language}`);
      expect(header).toContain(`link.url.${language}`);
    }
    for (const value of Object.values(localizedFixture('About body'))) {
      expect(csv).toContain(value);
    }
    expect(csv).toContain('Click Now');
    expect(csv).toContain('https://example.com');
  });

  it('GET /admin/pages/export exports all draft pages', async () => {
    const companyLect = blueprintToLect('company', cmsConfig.blueprint, cmsConfig.defaultLanguage);
    companyLect.name = localizedFixture('Acme');
    companyLect.address = localizedFixture('Acme Address');
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(103, 'page-uuid-103', 'Acme', 'acme', 6, 'company', stringifyLect(companyLect), 1, '1')
      .run();

    const response = await fetchWorker('/admin/pages/export?r=test', {
      headers: { Cookie: await authCookie() },
    });
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="pages-export-test.csv"');
    expect(csv).toContain('About');
    expect(csv).toContain('Acme');
  });

  it('GET /admin/pages/export/:pageType exports one draft page type', async () => {
    const companyLect = blueprintToLect('company', cmsConfig.blueprint, cmsConfig.defaultLanguage);
    companyLect.name = localizedFixture('Acme');
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(103, 'page-uuid-103', 'Acme', 'acme', 6, 'company', stringifyLect(companyLect), 1, '1')
      .run();

    const response = await fetchWorker('/admin/pages/export/default?r=test', {
      headers: { Cookie: await authCookie() },
    });
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="default-export-test.csv"');
    expect(csv).toContain('About');
    expect(csv).not.toContain('Acme');
  });

  it('shows CSV import and export links on the dashboard and page-type list', async () => {
    const [dashboard, pageTypeList] = await Promise.all([
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin/pages/list/default', { headers: { Cookie: await authCookie() } }),
    ]);

    const dashboardHtml = await dashboard.text();
    const pageTypeListHtml = await pageTypeList.text();

    expect(dashboardHtml).toContain('href="/admin/pages/import-v2/default"');
    expect(dashboardHtml).toContain('href="/admin/pages/export"');
    expect(pageTypeListHtml).toContain('href="/admin/pages/import-v2/default"');
    expect(pageTypeListHtml).toContain('href="/admin/pages/export/default"');
  });

  it('GET /admin paginates draft pages', async () => {
    await seedDraftPages('default', 105, 1000, 'Bulk Default');

    const firstPage = await fetchWorker('/admin', { headers: { Cookie: await authCookie() } });
    const firstHtml = await firstPage.text();

    expect(firstPage.status).toBe(200);
    expect(firstHtml).toContain('Showing 1-100 of 106 pages in draft');
    expect(firstHtml).toContain('Page 1 of 2');
    expect(firstHtml).toContain('href="/admin?page=2&amp;pagesize=100"');
    expect(firstHtml).not.toContain('Bulk Default 105');

    const secondPage = await fetchWorker('/admin?page=2', { headers: { Cookie: await authCookie() } });
    const secondHtml = await secondPage.text();

    expect(secondPage.status).toBe(200);
    expect(secondHtml).toContain('Showing 101-106 of 106 pages in draft');
    expect(secondHtml).toContain('Bulk Default 105');
    expect(secondHtml).toContain('href="/admin?page=1&amp;pagesize=100"');
  });

  it('GET /admin/pages/list/:pageType paginates one page type', async () => {
    await seedDraftPages('company', 105, 2000, 'Company Bulk');

    const response = await fetchWorker('/admin/pages/list/company?page=2&pagesize=25', {
      headers: { Cookie: await authCookie() },
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('Showing 26-50 of 105 pages in draft');
    expect(html).toContain('Page 2 of 5');
    expect(html).toContain('Company Bulk 026');
    expect(html).toContain('Company Bulk 050');
    expect(html).not.toContain('Company Bulk 001');
    expect(html).toContain('href="/admin/pages/list/company?page=1&amp;pagesize=25"');
    expect(html).toContain('href="/admin/pages/list/company?page=3&amp;pagesize=25"');
  });

  it('POST /admin/pages/import-v2/:pageType/confirm imports explicit localized CSV columns', async () => {
    const nameHeaders = cmsConfig.languages.map((language) => `name.${language}`);
    const bodyHeaders = cmsConfig.languages.map((language) => `body.${language}`);
    const importedNames = localizedFixture('Localized');
    const importedBodies = localizedFixture('Body');
    const response = await fetchWorker('/admin/pages/import-v2/default/confirm', {
      method: 'POST',
      body: form({
        action: 'new',
        csv: [
          ['name', 'slug', ...nameHeaders, ...bodyHeaders].join(','),
          [
            'Localized',
            'localized',
            ...cmsConfig.languages.map((language) => importedNames[language]),
            ...cmsConfig.languages.map((language) => importedBodies[language]),
          ].join(','),
        ].join('\n'),
      }),
      headers: { Cookie: await authCookie() },
    });
    const page = await env.DB.prepare('SELECT lect FROM draft_pages WHERE slug = ?')
      .bind('localized')
      .first<{ lect: string }>();
    const lect = JSON.parse(page?.lect ?? '{}') as {
      name?: Record<string, string>;
      body?: Record<string, string>;
    };

    expect(response.status).toBe(302);
    for (const language of cmsConfig.languages) {
      expect(lect.name?.[language]).toBe(importedNames[language]);
      expect(lect.body?.[language]).toBe(importedBodies[language]);
    }
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
    body.append('file', new File([pngBytes()], 'avatar.png', { type: 'image/png' }));

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
    body.append('file', new File([pngBytes()], 'avatar.png', { type: 'image/png' }));

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
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(pngBytes());
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
  // Real browsers always send Sec-Fetch-Site; mirror that so the fail-closed
  // cross-site check sees a same-origin signal unless a test overrides it.
  const headers = new Headers(init.headers);
  if (!headers.has('Sec-Fetch-Site') && !headers.has('Origin')) {
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  const request = new IncomingRequest(new URL(path, host), {
    redirect: 'manual',
    ...init,
    headers,
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

/** 10 bytes: the PNG signature plus two filler bytes. */
function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
}

function cookieValue(header: string | null, name: string): string {
  const match = header?.match(new RegExp(`${name}=([^;]+)`));
  return match?.[1] ?? '';
}

async function resetData(): Promise<void> {
  const adminTables = [
    'draft_page_tags',
    'trash_page_tags',
    'page_versions',
    'media_files',
    'draft_pages',
    'trash_pages',
    'tags',
    'tag_types',
    'sessions',
    'users',
  ];
  for (const table of adminTables) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }

  const publishedTables = [
    'live_page_tags',
    'live_pages',
  ];
  for (const table of publishedTables) {
    await env.PUBLISHED_DB.prepare(`DELETE FROM ${table}`).run();
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
  await env.PUBLISHED_DB.prepare(
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

async function seedDraftPages(pageType: string, count: number, idStart: number, namePrefix: string): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const padded = String(index).padStart(3, '0');
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        idStart + index,
        `${pageType}-bulk-uuid-${padded}`,
        `${namePrefix} ${padded}`,
        `${pageType}-bulk-${padded}`,
        10,
        pageType,
        basePageLect,
        1,
        '1',
      )
      .run();
  }
}
