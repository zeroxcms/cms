const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(name, value);
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

  const url = new URL(request.url);
  const validOrigins = new Set([url.origin, ...allowedOrigins]);
  const origin = request.headers.get('Origin');
  if (origin) {
    if (!validOrigins.has(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    return null;
  }

  if (isAllowedReferer(request.headers.get('Referer'), validOrigins)) {
    return null;
  }

  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return new Response('Forbidden', { status: 403 });
  }

  return null;
}

export function rejectCrossSiteRequest(request: Request, allowedOrigins: string[] = []): Response | null {
  const url = new URL(request.url);
  const validOrigins = new Set([url.origin, ...allowedOrigins]);
  const origin = request.headers.get('Origin');
  if (origin) {
    if (!validOrigins.has(origin)) {
      return new Response('Forbidden', { status: 403 });
    }
    return null;
  }

  if (isAllowedReferer(request.headers.get('Referer'), validOrigins)) {
    return null;
  }

  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return new Response('Forbidden', { status: 403 });
  }
  return null;
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
