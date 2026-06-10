// Unit tests for the IP-keyed rate-limit middleware.

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { rateLimitByIP } from '../src/middleware/rate-limit';
import type { Env, RateLimiter, Variables } from '../src/types';

function appWithLimiter(limiter: RateLimiter | undefined) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  app.use('/guarded', rateLimitByIP(() => limiter));
  app.post('/guarded', (c) => c.json({ ok: true }));
  return app;
}

describe('rateLimitByIP', () => {
  it('returns 429 with Retry-After when the limiter rejects', async () => {
    const seenKeys: string[] = [];
    const limiter: RateLimiter = {
      async limit({ key }) {
        seenKeys.push(key);
        return { success: false };
      },
    };

    const response = await appWithLimiter(limiter).request('/guarded', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    }, {} as Env);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(await response.json()).toEqual({ success: false, error: 'rate_limited' });
    expect(seenKeys).toEqual(['203.0.113.7']);
  });

  it('passes through when the limiter allows', async () => {
    const limiter: RateLimiter = { async limit() { return { success: true }; } };

    const response = await appWithLimiter(limiter).request('/guarded', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.7' },
    }, {} as Env);

    expect(response.status).toBe(200);
  });

  it('is a no-op when the binding is absent', async () => {
    const response = await appWithLimiter(undefined).request('/guarded', { method: 'POST' }, {} as Env);

    expect(response.status).toBe(200);
  });
});
