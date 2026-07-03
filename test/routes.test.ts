import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cmsConfig } from '../src/cms-config';
import { hashToken, signJWT } from '../src/utils/jwt';
import { blueprintToLect, stringifyLect } from '../src/utils/lect';
import { clearConfigCache } from '../src/plugins/config';
import { __injectPluginFetcher, clearManifestCache } from '../src/plugins/registry';
import { clearRolePermissionsCache } from '../src/utils/roles';
import type { JWTPayload } from '../src/types';

const IncomingRequest = Request;
const worker = (exports as unknown as { default: Fetcher }).default;
let ipCounter = 0;

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

interface RenderPayload {
  layoutData: Record<string, unknown>;
  bodyView: null | {
    viewPath: string;
    data: Record<string, unknown>;
  };
}

function renderPayload(html: string): RenderPayload {
  const match = html.match(/<script id="cms-render-payload"[^>]*>(.*?)<\/script>/s);
  if (!match) throw new Error('Missing cms-render-payload script');
  return JSON.parse(match[1]) as RenderPayload;
}

function bodyData(html: string): Record<string, unknown> {
  return renderPayload(html).bodyView?.data ?? {};
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
  clearRolePermissionsCache();
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

  it('marks auth and admin responses no-store while keeping assets cacheable', async () => {
    const [login, admin, asset] = await Promise.all([
      fetchWorker('/auth/login'),
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/assets/admin.css'),
    ]);

    expect(login.headers.get('Cache-Control')).toBe('no-store');
    expect(admin.headers.get('Cache-Control')).toBe('no-store');
    expect(asset.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('includes the session keepalive on admin pages only', async () => {
    const [login, admin] = await Promise.all([
      fetchWorker('/auth/login'),
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
    ]);

    expect(await admin.text()).toContain("fetch('/auth/refresh'");
    expect(await login.text()).not.toContain("fetch('/auth/refresh'");
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

  it('rejects mutations with Sec-Fetch-Site of none and no origin signal (not same-origin)', async () => {
    // 'none' is a top-level navigation, never a legitimate state-changing
    // request; without an Origin/Referer same-origin signal it is rejected.
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Direct', slug: 'direct', page_type: 'default' }),
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'none' },
    });

    expect(response.status).toBe(403);
  });

  it('allows mutations explicitly marked same-origin by Sec-Fetch-Site', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Direct', slug: 'direct', page_type: 'default' }),
      headers: { Cookie: await authCookie(), 'Sec-Fetch-Site': 'same-origin' },
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
    { name: 'GET /auth/start google', path: '/auth/start?provider=google', expectedStatus: 302, location: /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/ },
    { name: 'GET /auth/start microsoft', path: '/auth/start?provider=microsoft', expectedStatus: 302, location: /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize/ },
    { name: 'GET /auth/start apple', path: '/auth/start?provider=apple', expectedStatus: 302, location: /^https:\/\/appleid\.apple\.com\/auth\/authorize/ },
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
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:eventuai-user')
      .first()).toMatchObject({ provider: 'eventuai', provider_user_id: 'eventuai-user' });
    expect((await env.DB.prepare('SELECT id FROM sessions').all()).results).toHaveLength(1);
  });

  it('links another OAuth identity to the currently signed-in user', async () => {
    const accessCookie = await authCookie();
    const start = await fetchWorker('/auth/start?provider=github&link=1', {
      headers: { Cookie: accessCookie },
    });
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state');
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 12345,
          login: 'admin-gh',
          email: 'admin-github@example.com',
          name: 'Admin GitHub',
          avatar_url: 'https://example.com/admin.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state ?? '')}`, {
      headers: { Cookie: `oauth_state=${stateCookie}; ${accessCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('github:12345')
      .first()).toEqual({ user_id: 1, provider: 'github', provider_user_id: '12345' });
    expect(await env.DB.prepare('SELECT email FROM users WHERE id = 1')
      .first()).toEqual({ email: 'admin@example.com' });
  });

  it('signs in through an already linked secondary OAuth identity', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'github', '12345', 'github:12345')
      .run();

    const start = await fetchWorker('/auth/start?provider=github');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 12345,
          login: 'admin-gh',
          email: 'admin-github@example.com',
          name: 'Admin GitHub',
          avatar_url: 'https://example.com/admin.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `oauth_state=${stateCookie}` },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id FROM sessions').first()).toEqual({ user_id: 1 });
  });

  it('treats login-page OAuth starts as sign-in even when old refresh cookies remain valid', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'github', 'editor-gh', 'github:editor-gh')
      .run();

    const jti = 'still-valid-refresh';
    const [expiredAccessToken, refreshToken] = await Promise.all([
      signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signTestToken({ type: 'refresh', jti, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();

    const start = await fetchWorker('/auth/start?provider=github', {
      headers: { Cookie: `access_token=${expiredAccessToken}; refresh_token=${refreshToken}` },
    });
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }
      if (url === 'https://api.github.com/user') {
        return Response.json({
          id: 'editor-gh',
          login: 'editor-gh',
          email: 'editor-github@example.com',
          name: 'Editor GitHub',
          avatar_url: 'https://example.com/editor.png',
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
      headers: {
        Cookie: `oauth_state=${stateCookie}; access_token=${expiredAccessToken}; refresh_token=${refreshToken}`,
      },
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare(
      'SELECT user_id FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    )
      .bind(2)
      .first()).toEqual({ user_id: 2 });
  });

  it('handles Apple form_post callbacks using the id_token profile', async () => {
    const start = await fetchWorker('/auth/start?provider=apple');
    const location = new URL(start.headers.get('Location') ?? '');
    const state = location.searchParams.get('state') ?? '';
    const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

    expect(location.searchParams.get('response_mode')).toBe('form_post');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === 'https://appleid.apple.com/auth/token') {
        return Response.json({
          id_token: fakeIdToken({
            iss: 'https://appleid.apple.com',
            aud: 'test.apple.client',
            exp: Math.floor(Date.now() / 1000) + 600,
            sub: 'apple-user',
            email: 'apple@example.com',
          }),
        });
      }
      return new Response('Unexpected fetch', { status: 500 });
    }));

    const callback = await fetchWorker('/auth/callback', {
      method: 'POST',
      headers: {
        Cookie: `oauth_state=${stateCookie}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: form({ code: 'abc', state }),
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/admin');
    expect(await env.DB.prepare('SELECT user_id, provider, provider_user_id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('apple:apple-user')
      .first()).toMatchObject({ provider: 'apple', provider_user_id: 'apple-user' });
  });

  it('purges expired sessions during refresh', async () => {
    const jti = 'hygiene-refresh';
    const token = await signTestToken({ type: 'refresh', jti });
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, await hashToken(jti))
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 day'))",
    )
      .bind(1, 'stale-hash')
      .run();

    const response = await fetchWorker('/auth/refresh', {
      method: 'POST',
      headers: { Cookie: `refresh_token=${token}` },
    });

    expect(response.status).toBe(200);
    // The purge runs via waitUntil; poll briefly for it to land.
    await expect.poll(async () => {
      const row = await env.DB.prepare('SELECT id FROM sessions WHERE refresh_token_hash = ?')
        .bind('stale-hash')
        .first();
      return row;
    }, { timeout: 2000 }).toBeNull();
  });

  it('caps concurrent sessions per user at login', async () => {
    // Pre-create the user the mocked OAuth login signs in as.
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(50, 'eventuai:eventuai-user', 'eventuai@example.com', 'Eventuai User', '', 'editor')
      .run();
    for (let i = 0; i < 7; i++) {
      await env.DB.prepare(
        "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
      )
        .bind(50, `old-session-${i}`)
        .run();
    }

    const callback = await completeMockedOAuthLogin();
    expect(callback.status).toBe(302);

    await expect.poll(async () => {
      const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = 50').first<{ n: number }>();
      return rows?.n;
    }, { timeout: 2000 }).toBe(5);
  });

  it('rejects new sign-ups outside ALLOWED_EMAIL_DOMAINS', async () => {
    const testEnv = env as unknown as Record<string, unknown>;
    testEnv.ALLOWED_EMAIL_DOMAINS = 'cowise.co';
    try {
      const callback = await completeMockedOAuthLogin();

      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/auth/login?error=email_not_allowed');
      expect(await env.DB.prepare('SELECT id FROM users WHERE oauth_id = ?')
        .bind('eventuai:eventuai-user')
        .first()).toBeNull();
    } finally {
      delete testEnv.ALLOWED_EMAIL_DOMAINS;
    }
  });

  it('lets existing users sign in even when their domain is not allowlisted', async () => {
    await env.DB.prepare(
      'INSERT INTO users (oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?)',
    )
      .bind('eventuai:eventuai-user', 'eventuai@example.com', 'Eventuai User', '', 'editor')
      .run();
    const testEnv = env as unknown as Record<string, unknown>;
    testEnv.ALLOWED_EMAIL_DOMAINS = 'cowise.co';
    try {
      const callback = await completeMockedOAuthLogin();

      expect(callback.status).toBe(302);
      expect(callback.headers.get('Location')).toBe('/admin');
    } finally {
      delete testEnv.ALLOWED_EMAIL_DOMAINS;
    }
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

  it('retains an admin browser session with a valid refresh token after access expiry', async () => {
    const jti = 'browser-reopen-refresh';
    const [expiredAccessToken, refreshToken] = await Promise.all([
      signTestToken({ exp: Math.floor(Date.now() / 1000) - 60 }),
      signTestToken({ type: 'refresh', jti, exp: Math.floor(Date.now() / 1000) + 3600 }),
    ]);
    const oldRefreshHash = await hashToken(jti);
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(1, oldRefreshHash)
      .run();

    const response = await fetchWorker('/admin', {
      headers: { Cookie: `access_token=${expiredAccessToken}; refresh_token=${refreshToken}` },
    });
    const setCookies = response.headers.getSetCookie().join('\n');

    expect(response.status).toBe(200);
    expect(setCookies).toContain('access_token=');
    expect(setCookies).toContain('refresh_token=');
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE refresh_token_hash = ?')
      .bind(oldRefreshHash)
      .first()).toBeNull();
  });
});

describe('admin routes', () => {
  it.each<RouteCase>([
    { name: 'GET /admin', path: '/admin', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/profile', path: '/admin/profile', authenticated: true, expectedStatus: 200 },
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
    { name: 'GET /admin/pages/:id/read', path: '/admin/pages/101/read', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/pages/:id/read (missing page)', path: '/admin/pages/99999/read', authenticated: true, expectedStatus: 404 },
    { name: 'POST /admin/pages/:id/weight', method: 'POST', path: '/admin/pages/101/weight', body: form({ weight: '9', return_to: '/admin/pages/list/default' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/list/default?flash=Draft+weight+updated' },
    { name: 'POST /admin/pages/:id', method: 'POST', path: '/admin/pages/101', body: form({ name: 'About Updated', slug: 'about-updated', page_type: 'default', weight: '3' }), authenticated: true, expectedStatus: 302, location: '/admin/pages/101/edit?language=mis&flash=Page+updated+successfully' },
    { name: 'POST /admin/pages/:id/publish', method: 'POST', path: '/admin/pages/101/publish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+published+successfully' },
    { name: 'POST /admin/pages/pull/:uuid', method: 'POST', path: '/admin/pages/pull/page-uuid-101', authenticated: true, expectedStatus: 302, location: '/admin/pages/101/edit?flash=Draft+already+exists' },
    { name: 'POST /admin/pages/:id/unpublish', method: 'POST', path: '/admin/pages/101/unpublish', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+unpublished' },
    { name: 'POST /admin/pages/:id/delete', method: 'POST', path: '/admin/pages/101/delete', authenticated: true, expectedStatus: 302, location: '/admin?flash=Page+moved+to+trash' },
    { name: 'GET /admin/trash', path: '/admin/trash', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/trash?type= (filtered view)', path: '/admin/trash?type=default', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/trash/:id/restore', method: 'POST', path: '/admin/trash/201/restore', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+restored+to+draft' },
    { name: 'POST /admin/trash/:id/delete', method: 'POST', path: '/admin/trash/201/delete', authenticated: true, expectedStatus: 302, location: '/admin/trash?flash=Page+permanently+deleted' },
    { name: 'GET /admin/api/pages/:type', path: '/admin/api/pages/default', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/pages/:type?q=', path: '/admin/api/pages/default?q=about', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/pages/:type?q= (no match)', path: '/admin/api/pages/default?q=zzz', authenticated: true, expectedStatus: 200, json: [] },
    { name: 'GET /admin/api/pages/:type?id=', path: '/admin/api/pages/default?id=101', authenticated: true, expectedStatus: 200, json: [{ id: 101, page: 101, name: 'About', slug: 'about', label: '/about' }] },
    { name: 'GET /admin/api/tags/:type', path: '/admin/api/tags/categories', authenticated: true, expectedStatus: 200, json: [{ value: 301, label: 'News' }, { value: 302, label: 'Updates' }] },
    { name: 'POST /admin/api/page/:pageId/tag/:tagId', method: 'POST', path: '/admin/api/page/101/tag/301', authenticated: true, expectedStatus: 200 },
    { name: 'DELETE /admin/api/page/remove/page_tag/:id', method: 'DELETE', path: '/admin/api/page/remove/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'DELETE /admin/api/page_tag/:id', method: 'DELETE', path: '/admin/api/page_tag/401', authenticated: true, expectedStatus: 200, json: { type: 'DELETE_PAGE_TAG', payload: { success: true, id: 401 } } },
    { name: 'POST /admin/upload', method: 'POST', path: '/admin/upload', body: form({ dir: 'uploads' }), authenticated: true, expectedStatus: 200, json: { success: true, files: [], errors: [] } },
    { name: 'GET /admin/taxonomies', path: '/admin/taxonomies', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/new', path: '/admin/taxonomies/new', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/view/:slug (config)', path: '/admin/taxonomies/view/years', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/taxonomies/view/:slug missing', path: '/admin/taxonomies/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'POST /admin/taxonomies', method: 'POST', path: '/admin/taxonomies', body: form({ name: 'Topics', slug: 'topics' }), authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'GET /admin/taxonomies/:id/edit', path: '/admin/taxonomies/300/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/taxonomies/:id', method: 'POST', path: '/admin/taxonomies/300', body: form({ name: 'Categories', slug: 'categories' }), authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'POST /admin/taxonomies/:id/delete', method: 'POST', path: '/admin/taxonomies/300/delete', authenticated: true, expectedStatus: 302, location: '/admin/taxonomies' },
    { name: 'GET /admin/tags', path: '/admin/tags', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/tags/new', path: '/admin/tags/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags', method: 'POST', path: '/admin/tags', body: form({ name: 'Fresh Tag', slug: 'fresh-tag', taxonomy_id: '300' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'GET /admin/tags/:id/edit', path: '/admin/tags/301/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/tags/:id', method: 'POST', path: '/admin/tags/301', body: form({ name: 'News Updated', slug: 'news-updated', taxonomy_id: '300' }), authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'POST /admin/tags/:id/delete', method: 'POST', path: '/admin/tags/301/delete', authenticated: true, expectedStatus: 302, location: '/admin/tags' },
    { name: 'GET /admin/page_types', path: '/admin/page_types', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/page_types/new', path: '/admin/page_types/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/page_types', method: 'POST', path: '/admin/page_types', body: form({ name: 'Press Release', slug: 'press', blueprint: '["@date","name"]' }), authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'GET /admin/page_types/:id/edit', path: '/admin/page_types/700/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/page_types/:id', method: 'POST', path: '/admin/page_types/700', body: form({ name: 'Event', slug: 'event', blueprint: '["@date","name","location"]' }), authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'POST /admin/page_types/:id/delete', method: 'POST', path: '/admin/page_types/700/delete', authenticated: true, expectedStatus: 302, location: '/admin/page_types' },
    { name: 'GET /admin/block_types', path: '/admin/block_types', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/block_types/new', path: '/admin/block_types/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/block_types', method: 'POST', path: '/admin/block_types', body: form({ name: 'Gallery', slug: 'gallery', blueprint: '["label",{"pictures":["url"]}]' }), authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'GET /admin/block_types/:id/edit', path: '/admin/block_types/800/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/block_types/:id', method: 'POST', path: '/admin/block_types/800', body: form({ name: 'Hero Banner', slug: 'hero', blueprint: '["label",{"pictures":["url","alt"]}]' }), authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'POST /admin/block_types/:id/delete', method: 'POST', path: '/admin/block_types/800/delete', authenticated: true, expectedStatus: 302, location: '/admin/block_types' },
    { name: 'GET /admin/page_types/view/:slug (config)', path: '/admin/page_types/view/default', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/page_types/view/:slug missing', path: '/admin/page_types/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'GET /admin/block_types/view/:slug (config)', path: '/admin/block_types/view/logos', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/block_types/view/:slug missing', path: '/admin/block_types/view/nope', authenticated: true, expectedStatus: 404 },
    { name: 'GET /admin/users', path: '/admin/users', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/users/:id/edit', path: '/admin/users/2/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/users/:id', method: 'POST', path: '/admin/users/2', body: form({ roles: 'editor' }), authenticated: true, expectedStatus: 302, location: '/admin/users' },
    { name: 'GET /admin/roles', path: '/admin/roles', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/new', path: '/admin/roles/new', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/roles', method: 'POST', path: '/admin/roles', body: form({ name: 'reviewers', label: 'Reviewers' }), authenticated: true, expectedStatus: 302, location: '/admin/roles/reviewers/edit' },
    { name: 'GET /admin/roles/:name/edit (built-in)', path: '/admin/roles/editor/edit', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/:name/edit (custom)', path: '/admin/roles/authors/edit', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/roles/admin/edit (locked)', path: '/admin/roles/admin/edit', authenticated: true, expectedStatus: 200 },
    { name: 'POST /admin/roles/:name', method: 'POST', path: '/admin/roles/editor', body: form({ permissions: 'content:write' }), authenticated: true, expectedStatus: 302, location: '/admin/roles' },
    { name: 'POST /admin/roles/admin (locked)', method: 'POST', path: '/admin/roles/admin', body: form({ permissions: 'content:write' }), authenticated: true, expectedStatus: 403 },
    { name: 'POST /admin/roles/:name/delete (custom)', method: 'POST', path: '/admin/roles/authors/delete', authenticated: true, expectedStatus: 302, location: '/admin/roles' },
    { name: 'GET /admin/settings/system', path: '/admin/settings/system', authenticated: true, expectedStatus: 200 },
    { name: 'GET /admin/settings/menu (legacy redirect)', path: '/admin/settings/menu', authenticated: true, expectedStatus: 302, location: '/admin/settings/system' },
    { name: 'POST /admin/settings/system', method: 'POST', path: '/admin/settings/system', body: form({ visible_items: 'pages' }), authenticated: true, expectedStatus: 302, location: '/admin/settings/system?flash=saved' },
  ])('$name', async (route) => {
    await expectRoute(route);
  });

  it('renders config-only taxonomies in the tag form as read-only options', async () => {
    const response = await fetchWorker('/admin/tags/301/edit', { headers: { Cookie: await authCookie() } });
    expect(response.status).toBe(200);
    const data = bodyData(await response.text());

    expect(data.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '300', name: 'Categories', selected: true, disabled: false }),
      expect.objectContaining({ id: 'config:years', name: 'Years (config)', disabled: true }),
      expect.objectContaining({ id: 'config:topics', name: 'Topics (config)', disabled: true }),
      expect.objectContaining({ id: 'config:collections', name: 'Collections (config)', disabled: true }),
    ]));
  });

  it('persists tag weights and orders tag lists by weight', async () => {
    const cookie = await authCookie();
    const createResponse = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Featured', slug: 'featured', taxonomy_id: '300', weight: '1' }),
      headers: { Cookie: cookie },
    });
    expect(createResponse.status).toBe(302);

    const updateResponse = await fetchWorker('/admin/tags/301', {
      method: 'POST',
      body: form({ name: 'News', slug: 'news', taxonomy_id: '300', weight: '20' }),
      headers: { Cookie: cookie },
    });
    expect(updateResponse.status).toBe(302);

    const row = await env.DB.prepare('SELECT weight FROM tags WHERE slug = ?')
      .bind('featured')
      .first<{ weight: number }>();
    expect(row?.weight).toBe(1);

    const editData = bodyData(await (await fetchWorker('/admin/tags/301/edit', { headers: { Cookie: cookie } })).text());
    expect(editData.weight).toBe(20);

    const listData = bodyData(await (await fetchWorker('/admin/tags', { headers: { Cookie: cookie } })).text());
    expect((listData.tags as Array<{ slug: string; weight: number }>).map((tag) => [tag.slug, tag.weight])).toEqual([
      ['featured', 1],
      ['updates', 5],
      ['news', 20],
    ]);

    const apiResponse = await fetchWorker('/admin/api/tags/categories', { headers: { Cookie: cookie } });
    expect(apiResponse.status).toBe(200);
    expect((await apiResponse.json() as Array<{ label: string }>).map((tag) => tag.label)).toEqual([
      'Featured',
      'Updates',
      'News',
    ]);
  });

  it('renders the signed-in user profile with connected and available OAuth providers', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'google', 'google-admin', 'google:google-admin')
      .run();

    const response = await fetchWorker('/admin/profile', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());

    expect(data.name).toBe('Admin User');
    expect(data.email).toBe('admin@example.com');
    expect(data.hasIdentities).toBe(true);
    expect(data.identities).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'eventuai', label: 'Eventuai' }),
      expect.objectContaining({
        provider: 'google',
        label: 'Google',
        canDisconnect: true,
        disconnectHref: expect.stringMatching(/^\/admin\/profile\/identities\/\d+\/disconnect$/),
      }),
    ]));
    expect(data.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'google', connected: true }),
      expect.objectContaining({ provider: 'microsoft', connected: false, connectHref: '/auth/start?provider=microsoft&link=1' }),
    ]));
  });

  it('disconnects a linked OAuth identity from the profile page', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'google', 'google-admin', 'google:google-admin')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('google:google-admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/profile?flash=Sign-in+method+disconnected');
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('google:google-admin')
      .first()).toBeNull();
    expect(await env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
      .bind(1)
      .first()).toEqual({ oauth_id: 'eventuai:admin' });
  });

  it('does not disconnect the final OAuth identity', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/profile?error=At+least+one+sign-in+method+is+required');
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first()).not.toBeNull();
  });

  it('rotates the legacy primary identity before disconnecting it', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'eventuai', 'admin', 'eventuai:admin')
      .run();
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(1, 'github', 'admin-gh', 'github:admin-gh')
      .run();
    const identity = await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first<{ id: number }>();

    const response = await fetchWorker(`/admin/profile/identities/${identity?.id}/disconnect`, {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(await env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
      .bind(1)
      .first()).toEqual({ oauth_id: 'github:admin-gh' });
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE oauth_id = ?')
      .bind('eventuai:admin')
      .first()).toBeNull();
  });

  it('renders user delete actions for removable users only', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'github', 'editor-gh', 'github:editor-gh')
      .run();

    const response = await fetchWorker('/admin/users', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await response.text());

    expect(data.users).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 1,
        canDelete: false,
        identityProviders: [{ provider: 'eventuai', label: 'Eventuai' }],
      }),
      expect.objectContaining({
        id: 2,
        canDelete: true,
        identityProviders: [
          { provider: 'github', label: 'GitHub' },
          { provider: 'eventuai', label: 'Eventuai' },
        ],
        deleteAction: '/admin/users/2/delete',
      }),
    ]));
  });

  it('removes a user with their OAuth identities and sessions', async () => {
    await env.DB.prepare(
      `INSERT INTO user_oauth_identities (user_id, provider, provider_user_id, oauth_id)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(2, 'eventuai', 'editor', 'eventuai:editor')
      .run();
    await env.DB.prepare(
      "INSERT INTO sessions (user_id, refresh_token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 day'))",
    )
      .bind(2, 'editor-session')
      .run();

    const response = await fetchWorker('/admin/users/2/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?flash=User+removed');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM user_oauth_identities WHERE user_id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(2).first()).toBeNull();
    expect(await env.DB.prepare('SELECT action, entity_type, entity_id FROM audit_log WHERE action = ?')
      .bind('user.delete')
      .first()).toEqual({ action: 'user.delete', entity_type: 'user', entity_id: '2' });
  });

  it('does not let an admin remove their own user', async () => {
    const response = await fetchWorker('/admin/users/1/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?error=You+cannot+remove+your+own+user');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(1).first()).toEqual({ id: 1 });
  });

  it('does not let an admin remove the last administrator', async () => {
    const otherAdminCookie = `access_token=${await signTestToken({
      sub: '2',
      email: 'editor@example.com',
      name: 'Editor User',
      role: 'admin',
    })}`;

    const response = await fetchWorker('/admin/users/1/delete', {
      method: 'POST',
      headers: { Cookie: otherAdminCookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/users?error=Cannot+remove+the+last+administrator');
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(1).first()).toEqual({ id: 1 });
  });

  it('POST /admin/pages/batch-weight updates multiple page weights', async () => {
    const cookie = await authCookie();
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(102, 'page-uuid-102', 'Contact', 'contact', 5, 'default', basePageLect, 1, '1')
      .run();
    const updates = [
      { id: 101, weight: 10 },
      { id: 102, weight: 20 },
    ];

    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 
        Cookie: cookie,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ updates }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    const rows = await env.DB.prepare('SELECT id, weight FROM draft_pages WHERE id IN (?, ?)')
      .bind(101, 102)
      .all<{ id: number; weight: number }>();
    
    const weights = rows.results.reduce((acc, row) => {
      acc[row.id] = row.weight;
      return acc;
    }, {} as Record<number, number>);

    expect(weights[101]).toBe(10);
    expect(weights[102]).toBe(20);
  });

  it('POST /admin/pages/batch-weight rejects unauthenticated requests', async () => {
    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: [{ id: 101, weight: 10 }] }),
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/auth/login');
  });

  it('POST /admin/pages/batch-weight rejects malformed input', async () => {
    const response = await fetchWorker('/admin/pages/batch-weight', {
      method: 'POST',
      headers: { 
        Cookie: await authCookie(),
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ updates: 'not-an-array' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid input' });
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

  it('POST /admin/pages/pull/:uuid recreates a missing draft from published content', async () => {
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO live_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(920, 'live-only-uuid', 'Live Only', 'live-only', 12, 'default', basePageLect, 1, '1')
      .run();
    await env.PUBLISHED_DB.prepare('INSERT INTO live_page_tags (id, page_id, tag_id, weight) VALUES (?, ?, ?, ?)')
      .bind(921, 920, 301, 4)
      .run();

    const response = await fetchWorker('/admin/pages/pull/live-only-uuid', {
      method: 'POST',
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toMatch(/^\/admin\/pages\/\d+\/edit\?flash=Published\+page\+pulled\+to\+draft$/);
    const draft = await env.DB.prepare(
      'SELECT id, uuid, name, slug, weight, page_type, current_page_version_id FROM draft_pages WHERE uuid = ?',
    )
      .bind('live-only-uuid')
      .first<{ id: number; uuid: string; name: string; slug: string; weight: number; page_type: string; current_page_version_id: number }>();
    if (!draft) throw new Error('Expected pulled draft page');
    expect(draft).toMatchObject({
      uuid: 'live-only-uuid',
      name: 'Live Only',
      slug: 'live-only',
      weight: 12,
      page_type: 'default',
    });
    expect(draft.current_page_version_id).toBeTypeOf('number');
    expect(await env.DB.prepare('SELECT tag_id, weight FROM draft_page_tags WHERE page_id = ?')
      .bind(draft.id)
      .first<{ tag_id: number; weight: number }>()).toEqual({ tag_id: 301, weight: 4 });
    expect(await env.DB.prepare('SELECT lect, action FROM page_versions WHERE id = ?')
      .bind(draft.current_page_version_id)
      .first<{ lect: string; action: string }>()).toEqual({ lect: basePageLect, action: 'pull-published' });
  });

  it('renders a solid sidebar initial when the user has no avatar image', async () => {
    const response = await fetchWorker('/admin', {
      headers: { Cookie: await authCookie() },
    });
    const payload = renderPayload(await response.text());

    expect(payload.layoutData.hasUserAvatar).toBe(false);
    expect(payload.layoutData.userInitial).toBe('A');
  });

  it('CMS DB migration does not create live or runtime presence tables', async () => {
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN ('live_pages', 'live_page_tags', 'presence')
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
    const data = bodyData(await response.text());

    expect(response.status).toBe(200);
    expect(data.isConfirmImport).toBe(true);
    expect(JSON.stringify(data.importModeOptions)).toContain('New + Add Missing Fields');
    expect(JSON.stringify(data.importModeOptions)).toContain('Treat All Rows As New Pages');
    expect(JSON.stringify(data.newRows)).toContain('Fresh CSV');
    expect(data.existingRows).toMatchObject([{ existingId: 101, existingName: 'About' }]);
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

  it('preserves the page id and version history across a delete → restore cycle', async () => {
    const cookie = await authCookie();

    const deleteResponse = await fetchWorker('/admin/pages/101/delete', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(deleteResponse.status).toBe(302);

    // Trash keeps the original id, the current-version pointer, and the history.
    const trashed = await env.DB.prepare('SELECT id, current_page_version_id FROM trash_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number; current_page_version_id: number }>();
    expect(trashed).toMatchObject({ id: 101, current_page_version_id: 501 });
    const trashVersion = await env.DB.prepare('SELECT id, page_id FROM trash_page_versions WHERE id = ?')
      .bind(501)
      .first<{ id: number; page_id: number }>();
    expect(trashVersion).toMatchObject({ id: 501, page_id: 101 });
    // The draft copy and its versions are gone while it sits in trash.
    expect(await env.DB.prepare('SELECT id FROM draft_pages WHERE id = ?').bind(101).first()).toBeNull();

    const restoreResponse = await fetchWorker('/admin/trash/101/restore', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(restoreResponse.status).toBe(302);

    // Restore brings back the same id, the same current version, and the history.
    const restored = await env.DB.prepare('SELECT id, current_page_version_id FROM draft_pages WHERE uuid = ?')
      .bind('page-uuid-101')
      .first<{ id: number; current_page_version_id: number }>();
    expect(restored).toMatchObject({ id: 101, current_page_version_id: 501 });
    const restoredVersion = await env.DB.prepare('SELECT id, page_id, action FROM page_versions WHERE id = ?')
      .bind(501)
      .first<{ id: number; page_id: number; action: string }>();
    expect(restoredVersion).toMatchObject({ id: 501, page_id: 101, action: 'create' });
    // Trash is emptied for this page.
    expect(await env.DB.prepare('SELECT id FROM trash_pages WHERE uuid = ?').bind('page-uuid-101').first()).toBeNull();
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
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="pages-export-test.csv"; filename*=UTF-8\'\'pages-export-test.csv');
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
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="default-export-test.csv"; filename*=UTF-8\'\'default-export-test.csv');
    expect(csv).toContain('About');
    expect(csv).not.toContain('Acme');
  });

  it('shows CSV import and export links on the dashboard and page-type list', async () => {
    const [dashboard, pageTypeList] = await Promise.all([
      fetchWorker('/admin', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin/pages/list/default', { headers: { Cookie: await authCookie() } }),
    ]);

    const dashboardData = bodyData(await dashboard.text());
    const pageTypeListData = bodyData(await pageTypeList.text());

    expect(dashboardData.importHref).toBe('/admin/pages/import-v2/default');
    expect(dashboardData.exportHref).toBe('/admin/pages/export');
    expect(pageTypeListData.importHref).toBe('/admin/pages/import-v2/default');
    expect(pageTypeListData.exportHref).toBe('/admin/pages/export/default');
  });

  it('GET /admin filters pages by draft or live status', async () => {
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(901, 'draft-only-uuid', 'Draft Only', 'draft-only', 6, 'default', basePageLect, 1, '1')
      .run();

    const [draftResponse, liveResponse] = await Promise.all([
      fetchWorker('/admin?status=draft', { headers: { Cookie: await authCookie() } }),
      fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } }),
    ]);
    const draftData = bodyData(await draftResponse.text());
    const liveData = bodyData(await liveResponse.text());

    expect(draftResponse.status).toBe(200);
    expect(liveResponse.status).toBe(200);
    expect(draftData.pageCountLabel).toBe('Showing 1-1 of 1 draft page');
    expect(JSON.stringify(draftData.pages)).toContain('Draft Only');
    expect(JSON.stringify(draftData.pages)).not.toContain('About');
    expect(liveData.pageCountLabel).toBe('Showing 1-1 of 1 live page');
    expect(JSON.stringify(liveData.pages)).toContain('About');
    expect(JSON.stringify(liveData.pages)).not.toContain('Draft Only');
    expect(draftData.statusFilters).toContainEqual({ label: 'Draft', href: '/admin?status=draft', isActive: true });
    expect(liveData.statusFilters).toContainEqual({ label: 'Live', href: '/admin?status=live', isActive: true });
  });

  it('GET /admin?status=live shows published pages missing from drafts with a pull action', async () => {
    await env.PUBLISHED_DB.prepare(
      `INSERT INTO live_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(930, 'dashboard-live-only-uuid', 'Dashboard Live Only', 'dashboard-live-only', 8, 'default', basePageLect, 1, '1')
      .run();

    const response = await fetchWorker('/admin?status=live', { headers: { Cookie: await authCookie() } });
    const data = bodyData(await response.text());
    const pages = data.pages as Array<Record<string, unknown>>;
    const liveOnly = pages.find((page) => page.name === 'Dashboard Live Only');

    expect(response.status).toBe(200);
    expect(data.pageCountLabel).toBe('Showing 1-2 of 2 live pages');
    expect(liveOnly).toMatchObject({
      isDraftMissing: true,
      isPublished: true,
      editHref: '',
      pullAction: '/admin/pages/pull/dashboard-live-only-uuid',
    });
  });

  it('GET /admin paginates draft pages', async () => {
    await seedDraftPages('default', 105, 1000, 'Bulk Default');

    const firstPage = await fetchWorker('/admin', { headers: { Cookie: await authCookie() } });
    const firstData = bodyData(await firstPage.text());

    expect(firstPage.status).toBe(200);
    expect(firstData.pageCountLabel).toBe('Showing 1-100 of 106 pages in draft');
    expect(firstData.currentPage).toBe(1);
    expect(firstData.totalPages).toBe(2);
    expect(firstData.nextHref).toBe('/admin?page=2&pagesize=100');
    expect(JSON.stringify(firstData.pages)).not.toContain('Bulk Default 105');

    const secondPage = await fetchWorker('/admin?page=2', { headers: { Cookie: await authCookie() } });
    const secondData = bodyData(await secondPage.text());

    expect(secondPage.status).toBe(200);
    expect(secondData.pageCountLabel).toBe('Showing 101-106 of 106 pages in draft');
    expect(JSON.stringify(secondData.pages)).toContain('Bulk Default 105');
    expect(secondData.previousHref).toBe('/admin?page=1&pagesize=100');
  });

  it('GET /admin/pages/list/:pageType paginates one page type', async () => {
    await seedDraftPages('company', 105, 2000, 'Company Bulk');

    const response = await fetchWorker('/admin/pages/list/company?page=2&pagesize=25', {
      headers: { Cookie: await authCookie() },
    });
    const data = bodyData(await response.text());

    expect(response.status).toBe(200);
    expect(data.pageCountLabel).toBe('Showing 26-50 of 105 pages in draft');
    expect(data.currentPage).toBe(2);
    expect(data.totalPages).toBe(5);
    expect(JSON.stringify(data.pages)).toContain('Company Bulk 026');
    expect(JSON.stringify(data.pages)).toContain('Company Bulk 050');
    expect(JSON.stringify(data.pages)).not.toContain('Company Bulk 001');
    expect(data.previousHref).toBe('/admin/pages/list/company?page=1&pagesize=25');
    expect(data.nextHref).toBe('/admin/pages/list/company?page=3&pagesize=25');
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

  it('records page mutations in the audit log', async () => {
    const response = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Audited Page', slug: 'audited-page', page_type: 'default' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    await expect.poll(async () => {
      return env.DB.prepare("SELECT user_email, action, entity_type FROM audit_log WHERE action = 'page.create' ORDER BY id DESC LIMIT 1")
        .first<{ user_email: string; action: string; entity_type: string }>();
    }, { timeout: 2000 }).toMatchObject({
      user_email: 'admin@example.com',
      action: 'page.create',
      entity_type: 'page',
    });
  });

  it('rejects malformed legacy JSON imports without a server error', async () => {
    const response = await fetchWorker('/admin/pages/import/default', {
      method: 'POST',
      body: form({ items: '{not json' }),
      headers: { Cookie: await authCookie() },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/admin/pages/list/default?flash=Invalid+JSON+import+payload');
  });

  it('POST /admin/api/presence/:pageId stores sanitized presence in the page Durable Object', async () => {
    const response = await fetchWorker('/admin/api/presence/101', {
      method: 'POST',
      body: JSON.stringify({ lastActive: 'not-a-date', userAvatar: `javascript:${'x'.repeat(600)}` }),
      headers: { Cookie: await authCookie(), 'Content-Type': 'application/json' },
    });

    expect(response.status).toBe(200);
    const presenceResponse = await fetchWorker('/admin/api/presence/101', {
      headers: { Cookie: await authCookie() },
    });
    const rows = await presenceResponse.json() as Array<{
      user_id: string;
      user_name: string;
      user_avatar: string | null;
      last_seen: string;
      last_active: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: '1',
      user_name: 'Admin User',
      user_avatar: null,
    });
    expect(Number.isFinite(Date.parse(rows[0].last_active))).toBe(true);
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

describe('capability enforcement', () => {
  it('lets a moderator publish but not create or edit content', async () => {
    const publish = await fetchWorker('/admin/pages/101/publish', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(publish.status).toBe(302);

    const create = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Page', slug: 'mod-page', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(create.status).toBe(403);
  });

  it('lets a moderator move to trash and restore but not purge', async () => {
    const restore = await fetchWorker('/admin/trash/201/restore', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(restore.status).toBe(302);

    const purge = await fetchWorker('/admin/trash/201/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(purge.status).toBe(403);
  });

  it('lets an editor create content but not purge trash or reach plugins', async () => {
    const create = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Editor Page', slug: 'editor-page', page_type: 'default' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(302);

    const purge = await fetchWorker('/admin/trash/201/delete', {
      method: 'POST',
      headers: { Cookie: await authCookie('editor') },
    });
    expect(purge.status).toBe(403);

    const plugin = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(plugin.status).toBe(403);
  });

  it('keeps plugin admin pages admin-only even when a custom role has plugin:access', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('pluginviewer', 'Plugin Viewer').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('pluginviewer', 'plugin:access').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('pluginviewer') },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBeNull();
    expect(await response.text()).toBe('Forbidden: admin role required');
  });

  it('lets a custom role reach a plugin that declares the permission it was granted, but not other plugins', async () => {
    const pluginUrl = `https://plugin-${crypto.randomUUID()}.local`;
    const manifest = {
      id: 'checkin',
      name: 'Check-in',
      version: '1.0.0',
      permissions: [{ value: 'checkin:door', label: 'Check-in door access' }],
    };
    __injectPluginFetcher(pluginUrl, {
      fetch: async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const path = new URL(url).pathname;
        if (path === '/__plugin/manifest') return Response.json(manifest);
        return new Response('ok', { headers: { 'content-type': 'text/plain' } });
      },
    } as unknown as Fetcher);
    await env.DB.prepare('INSERT INTO plugins (label, url, enabled) VALUES (?, ?, 1)').bind('Checkin', pluginUrl).run();
    clearManifestCache();

    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('door-staff', 'Door Staff').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('door-staff', 'checkin:door').run();
    clearRolePermissionsCache();

    const allowed = await fetchWorker('/admin/plugins/checkin/dashboard', {
      headers: { Cookie: await authCookie('door-staff') },
    });
    expect(allowed.status).toBe(200);

    // The granted permission is namespaced to the checkin plugin — it must not
    // unlock a different (unregistered, in this test) plugin id.
    const other = await fetchWorker('/admin/plugins/events/dashboard', {
      headers: { Cookie: await authCookie('door-staff') },
    });
    expect(other.status).toBe(403);
  });

  it('lets an editor view page types but not create them (admin only)', async () => {
    const view = await fetchWorker('/admin/page_types', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(view.status).toBe(200);

    const create = await fetchWorker('/admin/page_types', {
      method: 'POST',
      body: form({ name: 'Nope', slug: 'nope', blueprint: '["name"]' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(403);
  });

  it('lets an editor view block types but not create them (admin only)', async () => {
    const view = await fetchWorker('/admin/block_types', {
      headers: { Cookie: await authCookie('editor') },
    });
    expect(view.status).toBe(200);

    const create = await fetchWorker('/admin/block_types', {
      method: 'POST',
      body: form({ name: 'Nope', slug: 'nope-block', blueprint: '["label"]' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(create.status).toBe(403);
  });

  it('blocks editors from the users and roles admin (admin only)', async () => {
    expect((await fetchWorker('/admin/users', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
    expect((await fetchWorker('/admin/roles', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
  });

  it('applies role permission changes to the permission gate', async () => {
    // A moderator cannot write content by default.
    const before = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Draft', slug: 'mod-draft', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(before.status).toBe(403);

    // An admin grants the moderator role content:write.
    const grant = await fetchWorker('/admin/roles/moderator', {
      method: 'POST',
      body: form({ permissions: 'content:write' }),
      headers: { Cookie: await authCookie() },
    });
    expect(grant.status).toBe(302);

    // Now the moderator can write content.
    const after = await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Mod Draft', slug: 'mod-draft', page_type: 'default' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(after.status).toBe(302);
  });

  it('returns JSON 403 with insufficient-permissions for moderator uploads', async () => {
    const response = await fetchWorker('/admin/upload', {
      method: 'POST',
      headers: { Accept: 'application/json', Cookie: await authCookie('moderator') },
      body: form({ dir: 'pictures' }),
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('insufficient-permissions');
    expect(await response.json()).toEqual({ success: false, error: 'Insufficient permissions' });
  });

  it('lets editors manage tags but blocks moderators', async () => {
    // Editors hold tag:write.
    const tag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Editor Tag', slug: 'editor-tag', taxonomy_id: '300' }),
      headers: { Cookie: await authCookie('editor') },
    });
    expect(tag.status).toBe(302);

    // Moderators do not.
    const modTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'Mod Tag', slug: 'mod-tag', taxonomy_id: '300' }),
      headers: { Cookie: await authCookie('moderator') },
    });
    expect(modTag.status).toBe(403);
  });

  it('separates tag:write from taxonomy:write', async () => {
    // A role granted only tag:write can manage tags but not taxonomies.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('tagger', 'Tagger').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('tagger', 'tag:write').run();
    // A role granted only taxonomy:write can manage taxonomies but not tags.
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('taxer', 'Taxer').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('taxer', 'taxonomy:write').run();
    clearRolePermissionsCache();

    const taggerTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'T1', slug: 't1', taxonomy_id: '300' }),
      headers: { Cookie: await authCookie('tagger') },
    });
    expect(taggerTag.status).toBe(302);

    const taggerTaxonomy = await fetchWorker('/admin/taxonomies', {
      method: 'POST',
      body: form({ name: 'Topics', slug: 'topics' }),
      headers: { Cookie: await authCookie('tagger') },
    });
    expect(taggerTaxonomy.status).toBe(403);

    const taxerTaxonomy = await fetchWorker('/admin/taxonomies', {
      method: 'POST',
      body: form({ name: 'Topics', slug: 'topics' }),
      headers: { Cookie: await authCookie('taxer') },
    });
    expect(taxerTaxonomy.status).toBe(302);

    const taxerTag = await fetchWorker('/admin/tags', {
      method: 'POST',
      body: form({ name: 'T2', slug: 't2', taxonomy_id: '300' }),
      headers: { Cookie: await authCookie('taxer') },
    });
    expect(taxerTag.status).toBe(403);
  });

  it('requires content:read for draft page lookup APIs', async () => {
    await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)').bind('tagger', 'Tagger').run();
    await env.DB.prepare('INSERT INTO role_permissions (role, permission) VALUES (?, ?)').bind('tagger', 'tag:write').run();
    clearRolePermissionsCache();

    const response = await fetchWorker('/admin/api/pages/default', {
      headers: { Cookie: await authCookie('tagger') },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('X-CMS-Error')).toBe('insufficient-permissions');
    expect(await response.json()).toEqual({ success: false, error: 'Insufficient permissions' });
  });

  it('requires content permissions and an existing page for sync and presence', async () => {
    const readPresence = await fetchWorker('/admin/api/presence/999999', {
      headers: { Cookie: await authCookie() },
    });
    expect(readPresence.status).toBe(404);
    expect(await readPresence.json()).toEqual({ error: 'page_not_found' });

    const writePresence = await fetchWorker('/admin/api/presence/101', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { Cookie: await authCookie('moderator'), 'Content-Type': 'application/json' },
    });
    expect(writePresence.status).toBe(403);
    expect(writePresence.headers.get('X-CMS-Error')).toBe('insufficient-permissions');

    const sync = await fetchWorker('/admin/api/sync/999999', {
      headers: { Cookie: await authCookie(), Upgrade: 'websocket' },
    });
    expect(sync.status).toBe(404);
    expect(await sync.text()).toBe('Page not found');
  });

  it('allows HTTPS plugin URLs and only localhost for HTTP plugin URLs', async () => {
    await env.DB.prepare('DELETE FROM plugins').run();

    const localhost = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Local', url: 'http://localhost:8787', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(localhost.status).toBe(302);

    const loopbackIp = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Loopback', url: 'http://127.0.0.1:8787', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(loopbackIp.status).toBe(200);
    expect(await loopbackIp.text()).toContain('URL must be HTTPS (http is allowed only for localhost).');

    const https = await fetchWorker('/admin/plugins-manage', {
      method: 'POST',
      body: form({ label: 'Remote', url: 'https://plugins.example.com', sort_order: '0' }),
      headers: { Cookie: await authCookie() },
    });
    expect(https.status).toBe(302);
  });
});

describe('permission-aware admin UI', () => {
  it('shows Users/Roles/System nav links only to users who can manage them', async () => {
    const adminPayload = renderPayload(await (await fetchWorker('/admin', { headers: { Cookie: await authCookie() } })).text());
    expect(adminPayload.layoutData.canManageUsers).toBe(true);
    expect(adminPayload.layoutData.canManageRoles).toBe(true);
    expect(adminPayload.layoutData.canManageMenu).toBe(true);
    expect(adminPayload.layoutData.sidebarSettingsNav).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Users' }),
      expect.objectContaining({ label: 'Roles' }),
      expect.objectContaining({ label: 'System' }),
    ]));

    const editorPayload = renderPayload(await (await fetchWorker('/admin', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(editorPayload.layoutData.canManageUsers).toBe(false);
    expect(editorPayload.layoutData.canManageRoles).toBe(false);
    expect(editorPayload.layoutData.canManageMenu).toBe(false);
    expect(editorPayload.layoutData.sidebarSettingsNav).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'System' }),
    ]));
  });

  it('persists system branding, sidebar visibility, and weight settings', async () => {
    const response = await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: new URLSearchParams([
        ['app_name', 'Control Room'],
        ['app_icon', 'settings'],
        ['visible_items', 'pages'],
        ['visible_items', 'trash'],
        ['weight_pages', '50'],
        ['weight_trash', '5'],
      ]),
      headers: { Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const dashboardPayload = renderPayload(await (await fetchWorker('/admin', { headers: { Cookie: await authCookie() } })).text());
    expect(dashboardPayload.layoutData.showSidebarPages).toBe(true);
    expect(dashboardPayload.layoutData.showSidebarTrash).toBe(true);
    expect(dashboardPayload.layoutData.showSidebarTags).toBe(false);
    expect(dashboardPayload.layoutData.showSidebarUsers).toBe(false);
    expect(dashboardPayload.layoutData.showSidebarMenu).toBe(true);
    expect(dashboardPayload.layoutData.siteTitle).toBe('Control Room');
    expect(dashboardPayload.layoutData.appIcon).toBe('settings');
    expect((dashboardPayload.layoutData.sidebarNav as Array<{ label: string }>).map((item) => item.label)).toEqual([
      'Trash',
      'Settings',
      'Pages',
    ]);

    const settingsData = bodyData(await (await fetchWorker('/admin/settings/system', { headers: { Cookie: await authCookie() } })).text());
    expect(settingsData.appName).toBe('Control Room');
    expect(settingsData.appIcon).toBe('settings');
    expect(settingsData.iconOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'settings', selected: true }),
    ]));
    expect(settingsData.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'pages', checked: true, weight: 50 }),
      expect.objectContaining({ value: 'tags', checked: false }),
      expect.objectContaining({ value: 'system', checked: true, locked: true }),
      expect.objectContaining({ value: 'trash', checked: true, weight: 5 }),
    ]));
  });

  it('requires menu:manage for the system settings page', async () => {
    expect((await fetchWorker('/admin/settings/system', { headers: { Cookie: await authCookie('editor') } })).status).toBe(403);
    expect((await fetchWorker('/admin/settings/system', {
      method: 'POST',
      body: form({ visible_items: 'pages' }),
      headers: { Cookie: await authCookie('editor') },
    })).status).toBe(403);
  });

  it('renders page types read-only for users without pagetype:write', async () => {
    // Editors lack pagetype:write.
    const list = bodyData(await (await fetchWorker('/admin/page_types', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(list.canWrite).toBe(false);
    expect(list.pageTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ editHref: '/admin/page_types/700/edit' }),
    ]));

    // The "new" form is not reachable.
    const newForm = await fetchWorker('/admin/page_types/new', { headers: { Cookie: await authCookie('editor') } });
    expect(newForm.status).toBe(302);
    expect(newForm.headers.get('Location')).toBe('/admin/page_types');

    // The edit route renders read-only (no Save button).
    const editForm = bodyData(await (await fetchWorker('/admin/page_types/700/edit', { headers: { Cookie: await authCookie('editor') } })).text());
    expect(editForm.readOnly).toBe(true);
  });

  it('keeps page types editable for admins', async () => {
    const list = bodyData(await (await fetchWorker('/admin/page_types', { headers: { Cookie: await authCookie() } })).text());
    expect(list.canWrite).toBe(true);
    const editForm = bodyData(await (await fetchWorker('/admin/page_types/700/edit', { headers: { Cookie: await authCookie() } })).text());
    expect(editForm.readOnly).toBe(false);
  });
});

describe('draft page slug uniqueness on save', () => {
  async function createPage(name: string, slug: string): Promise<void> {
    await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name, slug, page_type: 'default', weight: '5' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
  }

  it('appends a numeric suffix when the slug already exists', async () => {
    // seedBaseData already created a page with slug 'about'.
    await createPage('About Two', 'about');
    await createPage('About Three', 'about');

    const slugs = await env.DB.prepare("SELECT slug FROM draft_pages WHERE slug LIKE 'about%' ORDER BY slug ASC")
      .all<{ slug: string }>();
    expect(slugs.results.map((row) => row.slug)).toEqual(['about', 'about-2', 'about-3']);
  });

  it('keeps a page\'s own slug unchanged on update', async () => {
    const response = await fetchWorker('/admin/pages/101', {
      method: 'POST',
      body: form({ name: 'About Renamed', slug: 'about', page_type: 'default', weight: '5' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);
    const row = await env.DB.prepare('SELECT slug FROM draft_pages WHERE id = ?')
      .bind(101)
      .first<{ slug: string }>();
    expect(row?.slug).toBe('about');
  });
});

describe('page type block/taxonomy multi-select', () => {
  it('stores checked blocks and taxonomies as JSON arrays', async () => {
    // seedBaseData provides config blocks (logos, paragraphs) and taxonomy 'categories'.
    const body = new URLSearchParams([
      ['name', 'Landing'],
      ['slug', 'landing'],
      ['weight', '5'],
      ['blueprint', '["name"]'],
      ['block_lists', 'logos'],
      ['block_lists', 'paragraphs'],
      ['taxonomy_lists', 'categories'],
    ]);
    const response = await fetchWorker('/admin/page_types', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    expect(response.status).toBe(302);

    const row = await env.DB.prepare('SELECT block_lists, taxonomy_lists FROM page_types WHERE slug = ?')
      .bind('landing')
      .first<{ block_lists: string; taxonomy_lists: string }>();
    expect(JSON.parse(row!.block_lists)).toEqual(['logos', 'paragraphs']);
    expect(JSON.parse(row!.taxonomy_lists)).toEqual(['categories']);

    const editData = bodyData(await (await fetchWorker(
      `/admin/page_types/${(await env.DB.prepare('SELECT id FROM page_types WHERE slug = ?').bind('landing').first<{ id: number }>())!.id}/edit`,
      { headers: { Cookie: await authCookie() } },
    )).text());
    // The stored selections render as checked checkboxes.
    expect(editData.blockOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'logos', checked: true }),
    ]));
    expect(editData.taxonomyOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'categories', checked: true }),
    ]));
  });
});

describe('database page type with a scalar @name field', () => {
  it('renders the scalar name field instead of [object Object] when the lect drifted to a localized value', async () => {
    await env.DB.prepare('INSERT INTO page_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
      .bind(900, 'menu', 'Menu', JSON.stringify(['@name', { links: ['label', 'url'] }]))
      .run();
    clearConfigCache(); // the row was inserted directly, bypassing the admin route's cache bust

    // Simulates the editor form being rendered for one blueprint (localized `.name|en`)
    // while the page_type is submitted as `menu` (which declares a scalar `@name`).
    await fetchWorker('/admin/pages', {
      method: 'POST',
      body: form({ name: 'Main Menu', slug: 'main-menu', page_type: 'menu', weight: '5', '.name|en': 'Main Menu', '.links[0].label|en': 'Home', '.links[0].url|en': '/home' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: await authCookie() },
    });
    const row = await env.DB.prepare('SELECT id FROM draft_pages WHERE slug = ?')
      .bind('main-menu')
      .first<{ id: number }>();

    const editData = bodyData(await (await fetchWorker(`/admin/pages/${row!.id}/edit`, {
      headers: { Cookie: await authCookie() },
    })).text());
    const structuredModel = editData.structuredModel as { settingsFields: Array<{ inputName: string; value: string }> };
    expect(structuredModel.settingsFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ inputName: '@name', value: 'Main Menu' }),
    ]));
    expect(JSON.stringify(editData)).not.toContain('[object Object]');
  });
});

describe('structured editor weights', () => {
  it('renders item and block weights as compact header controls', async () => {
    const lect = JSON.parse(basePageLect) as Record<string, unknown>;
    const items = lect.items as Array<Record<string, unknown>>;
    items[0]._weight = 4;
    lect._blocks = [{ _type: 'label', _weight: 7, subject: { en: 'Featured' } }];
    await env.DB.prepare('UPDATE draft_pages SET lect = ?, current_page_version_id = NULL WHERE id = ?')
      .bind(JSON.stringify(lect), 101)
      .run();

    const singleItemData = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    let structuredModel = singleItemData.structuredModel as {
      itemGroups: Array<{ rows: Array<{ deleteAction: string; showDelete: boolean }> }>;
    };
    expect(structuredModel.itemGroups[0].rows[0]).toMatchObject({ deleteAction: 'item-delete:items|0', showDelete: false });

    items.push({ _weight: 8, name: { en: 'Second item' } });
    await env.DB.prepare('UPDATE draft_pages SET lect = ? WHERE id = ?')
      .bind(JSON.stringify(lect), 101)
      .run();

    const editData = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    structuredModel = editData.structuredModel as {
      itemGroups: Array<{ rows: Array<{ weightInputName: string; weight: number; deleteAction: string; showDelete: boolean }> }>;
      blocks: Array<{ weightInputName: string; weight: number; deleteAction: string }>;
    };
    expect(structuredModel.itemGroups[0].rows).toEqual([
      expect.objectContaining({ weightInputName: '.items[0]@_weight', weight: 4, deleteAction: 'item-delete:items|0', showDelete: true }),
      expect.objectContaining({ weightInputName: '.items[1]@_weight', weight: 8, deleteAction: 'item-delete:items|1', showDelete: true }),
    ]);
    expect(structuredModel.blocks).toEqual([
      expect.objectContaining({ weightInputName: '#0@_weight', weight: 7, deleteAction: 'block-delete:0' }),
    ]);
  });
});

describe('Lect JSON version diff', () => {
  it('shows a colour-coded diff against the current draft when previewing a version', async () => {
    // A second version of page 101 whose lect differs from the current draft.
    const changed = stringifyLect({ ...basePageLectObject, name: localizedFixture('About — REVISED') });
    await env.DB.prepare('INSERT INTO page_versions (id, page_id, lect, action) VALUES (?, ?, ?, ?)')
      .bind(502, 101, changed, 'update').run();

    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit?version=502', {
      headers: { Cookie: await authCookie() },
    })).text());

    // The raw-metadata panel renders the diff instead of the editable textarea.
    expect(data.hasLectDiff).toBe(true);
    expect(data.lectDiffHtml).toContain('bg-emerald-50');    // a line only in this version
    expect(data.lectDiffHtml).toContain('bg-rose-50');        // a line only in the current draft
    expect(data.lectDiffHtml).toContain('About — REVISED');   // the version's value, highlighted
  });

  it('keeps the editable Lect JSON textarea when not previewing a version', async () => {
    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect(data.hasLectDiff).toBe(false);
    expect((data.page as { lect: string }).lect).toContain('"name"');
  });
});

describe('Add-block picker scope', () => {
  it('offers every block type when the page type defines no block list', async () => {
    // Page type 'event' (seeded type 700) has no block list of its own.
    await env.DB.prepare(
      `INSERT INTO draft_pages (id, uuid, name, slug, weight, page_type, lect, creator, editors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(105, 'page-uuid-105', 'Gala', 'gala', 5, 'event', stringifyLect({ _type: 'event' }), 1, '1').run();

    const data = bodyData(await (await fetchWorker('/admin/pages/105/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    // 'hero' is a database block type, absent from the config default list — it
    // appears only because the 'event' type falls back to every block type.
    expect((data.structuredModel as { blockOptions: Array<{ value: string }> }).blockOptions).toEqual(expect.arrayContaining([
      { value: 'hero' },
    ]));
  });

  it("limits the picker to the page type's own block list when it defines one", async () => {
    // Page type 'default' has a config block list (default/label/logos/paragraphs), no 'hero'.
    const data = bodyData(await (await fetchWorker('/admin/pages/101/edit', {
      headers: { Cookie: await authCookie() },
    })).text());
    expect((data.structuredModel as { blockOptions: Array<{ value: string }> }).blockOptions).not.toEqual(expect.arrayContaining([
      { value: 'hero' },
    ]));
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
  // Unique client IP per request so the (real, miniflare-simulated) rate
  // limiter never throttles unrelated tests.
  if (!headers.has('CF-Connecting-IP')) {
    ipCounter += 1;
    headers.set('CF-Connecting-IP', `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`);
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

function fakeIdToken(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

/** Runs the full PKCE flow against a mocked eventuai provider and returns the callback response. */
async function completeMockedOAuthLogin(): Promise<Response> {
  const start = await fetchWorker('/auth/start?provider=eventuai');
  const location = new URL(start.headers.get('Location') ?? '');
  const state = location.searchParams.get('state') ?? '';
  const stateCookie = cookieValue(start.headers.get('Set-Cookie'), 'oauth_state');

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

  return fetchWorker(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: `oauth_state=${stateCookie}` },
  });
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
    'taxonomies',
    'page_types',
    'block_types',
    'settings',
    'roles',
    'role_permissions',
    'sessions',
    'user_oauth_identities',
    'users',
    'audit_log',
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
  await env.DB.prepare(
    'INSERT INTO users (id, oauth_id, email, name, avatar_url, role) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(2, 'eventuai:editor', 'editor@example.com', 'Editor User', '', 'editor')
    .run();
  // A custom role for the roles-admin route tests.
  await env.DB.prepare('INSERT INTO roles (name, label, builtin) VALUES (?, ?, 0)')
    .bind('authors', 'Authors')
    .run();

  await env.DB.prepare('INSERT INTO taxonomies (id, name, slug) VALUES (?, ?, ?)')
    .bind(300, 'Categories', 'categories')
    .run();

  await env.DB.prepare('INSERT INTO page_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
    .bind(700, 'event', 'Event', JSON.stringify(['@date', 'name', 'venue']))
    .run();
  await env.DB.prepare('INSERT INTO block_types (id, slug, name, blueprint) VALUES (?, ?, ?, ?)')
    .bind(800, 'hero', 'Hero', JSON.stringify(['label', { pictures: ['url'] }]))
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, taxonomy_id, lect) VALUES (?, ?, ?, ?, ?)')
    .bind(301, 'News', 'news', 300, JSON.stringify({ name: { en: 'News' } }))
    .run();
  await env.DB.prepare('INSERT INTO tags (id, name, slug, taxonomy_id, lect) VALUES (?, ?, ?, ?, ?)')
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
