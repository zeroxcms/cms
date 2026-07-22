import { describe, expect, it } from 'vitest';
import { pluginDocumentResponse } from '../src/security/plugin-proxy';

describe('plugin document CSP', () => {
  it('allows loopback HTTP images when the CMS document is served locally', () => {
    const response = pluginDocumentResponse(
      new Response('<!doctype html><img src="http://localhost:8080/media/picture.jpg">', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      'http://localhost:8787/admin/plugins/events/edm/12/preview',
    );

    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("img-src 'self' data: https: http://localhost:* http://127.0.0.1:*");
    expect(csp).not.toContain('[::1]');
  });

  it('does not allow HTTP images for production CMS documents', () => {
    const response = pluginDocumentResponse(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      'https://cms.eventuai.com/admin/plugins/events/edm/12/preview',
    );

    const csp = response.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("img-src 'self' data: https:");
    expect(csp).not.toContain('http://localhost:*');
  });
});
