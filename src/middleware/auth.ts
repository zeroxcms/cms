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
import { signJWT, verifyJWT, hashToken, generateTokenId } from '../utils/jwt';
import { effectivePermissions, resolveRolePermissions, splitRoles } from '../utils/roles';
import type { Permission } from '../types';
import {
  accessCookieName,
  clearAuthCookie,
  readAuthCookie,
  refreshCookieName,
  setAuthCookie,
} from '../utils/cookies';
import type { Env, Variables, JWTPayload } from '../types';

const ACCESS_TOKEN_TTL = 15 * 60;       // 15 minutes
const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days

function wantsJsonResponse(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname === '/admin/upload'
    || url.pathname.startsWith('/admin/api/')
    || !!request.headers.get('Accept')?.includes('application/json');
}

function jsonError(body: { success: false; error: string }, status: number, cmsError: string): Response {
  return Response.json(body, {
    status,
    headers: { 'X-CMS-Error': cmsError },
  });
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const secret = c.env.JWT_SECRET;

  // Helper: read access token and verify
  const readAccess = async (): Promise<JWTPayload | null> => {
    const token = readAuthCookie(c, accessCookieName);
    if (!token) return null;
    const payload = await verifyJWT(token, secret);
    if (!payload || payload.type !== 'access') return null;
    return payload;
  };

  // Helper: perform refresh flow
  const tryRefresh = async (): Promise<JWTPayload | null> => {
    const refreshToken = readAuthCookie(c, refreshCookieName);
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

    // Opportunistic hygiene: purge expired sessions without blocking the response.
    c.executionCtx.waitUntil(
      c.env.DB.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run(),
    );

    // Set cookies
    setAuthCookie(c, accessCookieName, newAccessToken, ACCESS_TOKEN_TTL);
    setAuthCookie(c, refreshCookieName, newRefreshToken, REFRESH_TOKEN_TTL);

    return accessPayload;
  };

  let user = await readAccess();
  if (!user) {
    user = await tryRefresh();
  }

  if (!user) {
    clearAuthCookie(c, accessCookieName);
    clearAuthCookie(c, refreshCookieName);
    if (wantsJsonResponse(c.req.raw)) {
      return jsonError({ success: false, error: 'Authentication required' }, 401, 'authentication-required');
    }
    return c.redirect('/auth/login');
  }

  c.set('user', user);
  return next();
});

/** Middleware that gates /admin to anyone whose roles grant at least one
 *  capability (admin/editor/moderator and any custom role with permissions;
 *  a permission-less viewer/custom role is blocked). */
export const editorGuard = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const user = c.get('user');
  const map = await resolveRolePermissions(c.env);
  if (effectivePermissions(map, user.role).size === 0) {
    if (wantsJsonResponse(c.req.raw)) {
      return jsonError({ success: false, error: 'Editor role required' }, 403, 'editor-role-required');
    }
    return c.redirect('/auth/login?error=forbidden');
  }
  return next();
});

/**
 * Middleware factory that enforces a specific capability. Accepts both built-in
 * permissions and plugin-declared permission strings. The admin role always
 * passes — plugin permissions are not stored in the built-in permission set so
 * admin is special-cased here rather than re-deriving the full set on every call.
 * Apply per-route on top of editorGuard so each mutation requires the least
 * privilege it needs.
 */
export function requirePermission(permission: Permission | string) {
  return createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
    const user = c.get('user');
    if (splitRoles(user.role).includes('admin')) return next();
    const map = await resolveRolePermissions(c.env);
    if (!effectivePermissions(map, user.role).has(permission as Permission)) {
      if (wantsJsonResponse(c.req.raw)) {
        return jsonError({ success: false, error: 'Insufficient permissions' }, 403, 'insufficient-permissions');
      }
      return c.text('Forbidden: insufficient permissions', 403);
    }
    return next();
  });
}
