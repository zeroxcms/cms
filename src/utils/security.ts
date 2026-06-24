const SECURITY_HEADERS: Record<string, string> = {
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

export function buildContentSecurityPolicy(nonce: string): string {
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' https://static.cloudflareinsights.com`
    : "'self' https://static.cloudflareinsights.com";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function withSecurityHeaders(response: Response, cspNonce = ''): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
  }
  // A route may set its own (stricter) CSP, e.g. the media sandbox; don't clobber it.
  if (!secured.headers.has('Content-Security-Policy')) {
    secured.headers.set('Content-Security-Policy', buildContentSecurityPolicy(cspNonce));
  }
  // Default to DENY, but let a route opt into same-origin framing (e.g. the plugin
  // admin proxy lets a plugin's preview be shown in a same-origin <iframe>).
  if (!secured.headers.has('X-Frame-Options')) {
    secured.headers.set('X-Frame-Options', 'DENY');
  }
  return secured;
}

export function withSensitiveCacheHeaders(response: Response, request: Request): Response {
  const secured = new Response(response.body, response);
  const pathname = new URL(request.url).pathname;
  if (pathname.startsWith('/admin') || pathname.startsWith('/auth')) {
    secured.headers.set('Cache-Control', 'no-store');
    secured.headers.set('Pragma', 'no-cache');
  }
  return secured;
}

export function canonicalHostResponse(request: Request, canonicalOrigin: string): Response | null {
  const url = new URL(request.url);
  if (isLocalHost(url.hostname)) return null;

  const canonical = new URL(canonicalOrigin);
  if (url.origin === canonical.origin) return null;

  if (request.method === 'GET' || request.method === 'HEAD') {
    const redirectUrl = new URL(url.pathname + url.search, canonical.origin);
    return Response.redirect(redirectUrl.toString(), 308);
  }

  return new Response('Not Found', { status: 404 });
}

export function rejectCrossOriginMutation(request: Request, allowedOrigins: string[] = []): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
  return checkCrossSite(request, allowedOrigins);
}

export function rejectCrossSiteRequest(request: Request, allowedOrigins: string[] = []): Response | null {
  return checkCrossSite(request, allowedOrigins);
}

/**
 * Fail-closed cross-site check: a request is allowed only when at least one
 * browser signal (Origin, Referer, Sec-Fetch-Site) positively identifies it
 * as same-origin. Headerless clients (curl scripts) must send an Origin
 * header matching the canonical origin.
 */
function checkCrossSite(request: Request, allowedOrigins: string[]): Response | null {
  const url = new URL(request.url);
  const validOrigins = new Set([url.origin, ...allowedOrigins]);

  const origin = request.headers.get('Origin');
  if (origin) {
    if (!validOrigins.has(origin)) {
      return forbiddenResponse(request, 'Origin is not allowed');
    }
    return null;
  }

  if (isAllowedReferer(request.headers.get('Referer'), validOrigins)) {
    return null;
  }

  const secFetchSite = request.headers.get('Sec-Fetch-Site');
  if (secFetchSite === 'same-origin' || secFetchSite === 'same-site' || secFetchSite === 'none') {
    return null;
  }

  return forbiddenResponse(request, 'Cross-site request rejected');
}

function forbiddenResponse(request: Request, error: string): Response {
  const headers = { 'X-CMS-Error': error.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') };
  if (wantsJsonResponse(request)) {
    return Response.json({ success: false, error }, { status: 403, headers });
  }
  return new Response('Forbidden', { status: 403, headers });
}

function wantsJsonResponse(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return pathname === '/admin/upload'
    || pathname.startsWith('/admin/api/')
    || !!request.headers.get('Accept')?.includes('application/json');
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function isAllowedReferer(referer: string | null, validOrigins: Set<string>): boolean {
  if (!referer) return false;
  try {
    return validOrigins.has(new URL(referer).origin);
  } catch {
    return false;
  }
}
