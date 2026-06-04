// ============================================================
// Auth middleware – validates dual JWT on every protected route.
//
// Strategy:
//  1. Read `access_token` httpOnly cookie → verify HS256 JWT
//  2. If expired, attempt silent refresh via `refresh_token` cookie:
//     a. Verify refresh JWT signature & expiry
//     b. Look up the hashed jti in the sessions table (revocation check)
//     c. Issue new access + refresh tokens, rotate the session row
//  3. Store the decoded access-token payload in c.var.user
//  4. If no valid token can be obtained → redirect to /auth/login
// ============================================================

import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { signJWT, verifyJWT, hashToken, generateTokenId } from '../utils/jwt';
import { hasAnyRole } from '../utils/roles';
import { EDITOR_ROLES } from '../types';
import type { Env, Variables, JWTPayload } from '../types';

const ACCESS_TOKEN_TTL = 15 * 60;       // 15 minutes
const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function wantsJsonResponse(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname === '/admin/upload'
    || url.pathname.startsWith('/admin/api/')
    || !!request.headers.get('Accept')?.includes('application/json');
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const secret = c.env.JWT_SECRET;

  // Helper: read access token and verify
  const readAccess = async (): Promise<JWTPayload | null> => {
    const token = getCookie(c, 'access_token');
    if (!token) return null;
    const payload = await verifyJWT(token, secret);
    if (!payload || payload.type !== 'access') return null;
    return payload;
  };

  // Helper: perform refresh flow
  const tryRefresh = async (): Promise<JWTPayload | null> => {
    const refreshToken = getCookie(c, 'refresh_token');
    if (!refreshToken) return null;

    const refreshPayload = await verifyJWT(refreshToken, secret);
    if (!refreshPayload || refreshPayload.type !== 'refresh' || !refreshPayload.jti) {
      return null;
    }

    // Revocation check – the hashed jti must exist in the sessions table
    const tokenHash = await hashToken(refreshPayload.jti);
    const session = await c.env.DB.prepare(
      'SELECT id, user_id FROM sessions WHERE refresh_token_hash = ? AND expires_at > CURRENT_TIMESTAMP',
    )
      .bind(tokenHash)
      .first<{ id: number; user_id: number }>();

    if (!session) return null;

    // Fetch up-to-date user data (role may have changed)
    const user = await c.env.DB.prepare(
      'SELECT id, email, name, role FROM users WHERE id = ?',
    )
      .bind(session.user_id)
      .first<{ id: number; email: string; name: string; role: string }>();

    if (!user) return null;

    const now = Math.floor(Date.now() / 1000);
    const newJti = generateTokenId();

    // Issue new access token
    const accessPayload: JWTPayload = {
      sub: String(user.id),
      email: user.email,
      name: user.name,
      role: user.role,
      type: 'access',
      exp: now + ACCESS_TOKEN_TTL,
      iat: now,
    };
    const newAccessToken = await signJWT(accessPayload, secret);

    // Issue new refresh token (rotation)
    const newRefreshPayload: JWTPayload = {
      sub: String(user.id),
      email: user.email,
      name: user.name,
      role: user.role,
      type: 'refresh',
      jti: newJti,
      exp: now + REFRESH_TOKEN_TTL,
      iat: now,
    };
    const newRefreshToken = await signJWT(newRefreshPayload, secret);
    const newTokenHash = await hashToken(newJti);

    // Rotate session row
    await c.env.DB.prepare(
      `UPDATE sessions SET refresh_token_hash = ?, expires_at = datetime('now', '+7 days') WHERE id = ?`,
    )
      .bind(newTokenHash, session.id)
      .run();

    // Set cookies
    const cookieOpts = {
      httpOnly: true,
      secure: isSecureRequest(c.req.raw),
      sameSite: 'Lax' as const,
      path: '/',
    };
    setCookie(c, 'access_token', newAccessToken, {
      ...cookieOpts,
      maxAge: ACCESS_TOKEN_TTL,
    });
    setCookie(c, 'refresh_token', newRefreshToken, {
      ...cookieOpts,
      maxAge: REFRESH_TOKEN_TTL,
    });

    return accessPayload;
  };

  let user = await readAccess();
  if (!user) {
    user = await tryRefresh();
  }

  if (!user) {
    deleteCookie(c, 'access_token', { path: '/' });
    deleteCookie(c, 'refresh_token', { path: '/' });
    if (wantsJsonResponse(c.req.raw)) {
      return c.json({ success: false, error: 'Authentication required' }, 401);
    }
    return c.redirect('/auth/login');
  }

  c.set('user', user);
  return next();
});

/** Middleware that enforces admin / editor / moderator role. */
export const editorGuard = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const user = c.get('user');
  if (!hasAnyRole(user.role, EDITOR_ROLES)) {
    if (wantsJsonResponse(c.req.raw)) {
      return c.json({ success: false, error: 'Editor role required' }, 403);
    }
    return c.redirect('/auth/login?error=forbidden');
  }
  return next();
});
