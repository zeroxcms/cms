// Tests for the nonce-based CSP and JWT iss/aud hardening.

import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { signJWT, verifyJWT } from '../src/utils/jwt';
import type { JWTPayload } from '../src/types';

const worker = (exports as unknown as { default: Fetcher }).default;

describe('content security policy', () => {
  it('serves admin pages with a per-request nonce and no unsafe sources', async () => {
    const response = await worker.fetch(new Request('http://localhost/auth/login'));
    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const html = await response.text();

    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('cdn.tailwindcss.com');
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');

    const nonceMatch = scriptSrc.match(/'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    // Inline scripts in the rendered HTML must carry the same nonce.
    for (const tag of html.match(/<script[^>]*>/g) ?? []) {
      expect(tag).toContain(`nonce="${nonceMatch![1]}"`);
    }
  });

  it('uses a fresh nonce per request', async () => {
    const [first, second] = await Promise.all([
      worker.fetch(new Request('http://localhost/auth/login')),
      worker.fetch(new Request('http://localhost/auth/login')),
    ]);
    const nonce = (r: Response) => r.headers.get('Content-Security-Policy')?.match(/'nonce-([^']+)'/)?.[1];

    expect(nonce(first)).toBeTruthy();
    expect(nonce(first)).not.toBe(nonce(second));
  });

  it('links revisioned local admin assets instead of the Tailwind CDN', async () => {
    const response = await worker.fetch(new Request('http://localhost/auth/login'));
    const html = await response.text();

    expect(html).toMatch(/\/assets\/admin\.css\?r=[^"'<]+/);
    expect(html).toMatch(/\/assets\/table-filter\.js\?r=[^"'<]+/);
    expect(html).toMatch(/\/assets\/icons\.svg\?r=[^"'<#]+#/);
    expect(html).not.toContain('cdn.tailwindcss.com');
  });

  it.each([
    { path: '/assets/admin.css', contentType: 'text/css' },
    { path: '/assets/table-filter.js', contentType: 'text/javascript' },
  ])('serves $path', async ({ path, contentType }) => {
    const response = await worker.fetch(new Request(`http://localhost${path}`));

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain(contentType);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it('keeps mobile form controls at 16px to avoid iOS focus zoom', async () => {
    const response = await worker.fetch(new Request('http://localhost/assets/admin.css'));
    const css = await response.text();

    expect(css).toContain('@media (max-width:767px)');
    expect(css).toContain('input,select,textarea');
    expect(css).toContain('font-size:16px');
  });
});

describe('jwt iss/aud claims', () => {
  const basePayload = {
    sub: '1',
    email: 'admin@example.com',
    name: 'Admin User',
    role: 'admin',
    type: 'access' as const,
    exp: Math.floor(Date.now() / 1000) + 900,
  };

  it('round-trips tokens signed by signJWT', async () => {
    const token = await signJWT(basePayload, env.JWT_SECRET);
    const payload = await verifyJWT(token, env.JWT_SECRET);

    expect(payload).not.toBeNull();
    expect(payload?.iss).toBe('worker-cms');
    expect(payload?.aud).toBe('worker-cms-admin');
  });

  it('rejects tokens without iss/aud even when correctly signed', async () => {
    // Hand-roll a token with a valid signature but no iss/aud claims.
    const encode = (obj: unknown) => btoa(JSON.stringify(obj))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({ ...basePayload, iat: Math.floor(Date.now() / 1000) } satisfies Partial<JWTPayload>);
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${payload}`));
    const sigEncoded = btoa(String.fromCharCode(...new Uint8Array(signature)))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

    expect(await verifyJWT(`${header}.${payload}.${sigEncoded}`, env.JWT_SECRET)).toBeNull();
  });

});
