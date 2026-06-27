import type { JWTPayload } from '../types';
import { sanitizePluginHtmlResponse } from './plugin-sanitize';

const FORWARD_HEADERS = [
  'accept',
  'accept-language',
  'content-type',
  'content-length',
  'user-agent',
  'x-requested-with',
];

export function buildPluginProxyHeaders(source: Headers, user: JWTPayload, pluginSecret: string): Headers {
  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = source.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    'x-cms-user',
    JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  );
  headers.set('x-plugin-secret', pluginSecret);
  return headers;
}

export function wantsCmsChrome(response: Response): boolean {
  return response.headers.get('x-cms-chrome') === '1'
    && (response.headers.get('content-type') ?? '').includes('text/html');
}

/** Decodes the percent-encoded x-cms-title header (plugins encode it for header safety). */
export function decodePluginTitle(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function pluginDocumentResponse(upstreamResponse: Response): Response {
  const contentType = upstreamResponse.headers.get('content-type') ?? '';
  const response = contentType.includes('text/html')
    ? sanitizePluginHtmlResponse(upstreamResponse)
    : new Response(upstreamResponse.body, upstreamResponse);
  const allowFraming = upstreamResponse.headers.get('x-cms-frame') === '1';

  response.headers.delete('x-cms-frame');
  if (allowFraming) response.headers.set('X-Frame-Options', 'SAMEORIGIN');
  if (!response.headers.has('Content-Security-Policy')) {
    response.headers.set('Content-Security-Policy', buildPluginDocumentCsp(allowFraming));
  }
  return response;
}

function buildPluginDocumentCsp(allowFraming: boolean): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "base-uri 'none'",
    allowFraming ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
  ].join('; ');
}

let sharedOriginWarned = false;
export function warnSharedPluginOrigin(): void {
  if (sharedOriginWarned) return;
  sharedOriginWarned = true;
  console.warn(
    'Plugin admin pages are served on the CMS origin; a compromised plugin would '
    + 'gain same-origin authority. Serve plugins from a dedicated origin to isolate them.',
  );
}
