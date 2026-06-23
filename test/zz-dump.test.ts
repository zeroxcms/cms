import { env } from 'cloudflare:workers';
import { describe, it } from 'vitest';
import { signJWT } from '../src/utils/jwt';

describe('dump', () => {
  it('dumps admin html', async () => {
    const { default: worker } = await import('../src/index');
    const now = Math.floor(Date.now() / 1000);
    const token = await signJWT({ sub: '1', email: 'admin@example.com', name: 'Admin User', role: 'admin', type: 'access', exp: now + 900, iat: now } as any, env.JWT_SECRET);
    const req = new Request('http://localhost/admin', { headers: { Cookie: `access_token=${token}`, 'Sec-Fetch-Site': 'same-origin', 'CF-Connecting-IP': '10.5.5.6' } });
    const res = await worker.fetch(req as any, env as any, {} as any);
    const html = await res.text();
    console.log('===HTMLSTART===');
    console.log(html);
    console.log('===HTMLEND===');
  });
});
