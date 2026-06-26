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
import { verifyJWT } from '../security/jwt';
import { effectivePermissions, resolveRolePermissions, splitRoles } from '../utils/roles';
import type { Permission } from '../types';
import {
  accessCookieName,
  clearAuthCookie,
  readAuthCookie,
  refreshCookieName,
  setAuthCookie,
} from '../security/cookies';
import type { Env, Variables, JWTPayload } from '../types';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  purgeExpiredSessions,
  rotateAuthSession,
} from '../security/sessions';

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

    const rotated = await rotateAuthSession(c.env.DB, secret, refreshToken);
    if (!rotated.ok) return null;

    // Opportunistic hygiene: purge expired sessions without blocking the response.
    c.executionCtx.waitUntil(purgeExpiredSessions(c.env.DB));

    // Set cookies
    setAuthCookie(c, accessCookieName, rotated.accessToken, ACCESS_TOKEN_TTL);
    setAuthCookie(c, refreshCookieName, rotated.refreshToken, REFRESH_TOKEN_TTL);

    return rotated.accessPayload;
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

/** Admin-role gate for routes that should not be delegated to custom capabilities. */
export const requireAdmin = createMiddleware<{
  Bindings: Env;
  Variables: Variables;
}>(async (c, next) => {
  const user = c.get('user');
  if (splitRoles(user.role).includes('admin')) return next();
  if (wantsJsonResponse(c.req.raw)) {
    return jsonError({ success: false, error: 'Admin role required' }, 403, 'admin-role-required');
  }
  return c.text('Forbidden: admin role required', 403);
});
