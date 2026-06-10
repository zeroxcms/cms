// ============================================================
// Auth cookie helpers.
//
// On HTTPS the auth cookies use the __Host- prefix, which the
// browser only accepts with Secure, Path=/ and no Domain —
// locking the cookie to this exact origin. Local development
// over plain HTTP falls back to unprefixed names because
// browsers reject __Host- cookies without Secure.
//
// Readers also fall back to the legacy unprefixed names for one
// release so sessions issued before the rename keep working.
// ============================================================

import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';

export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

export function accessCookieName(secure: boolean): string {
  return secure ? '__Host-access_token' : 'access_token';
}

export function refreshCookieName(secure: boolean): string {
  return secure ? '__Host-refresh_token' : 'refresh_token';
}

export function oauthStateCookieName(secure: boolean): string {
  return secure ? '__Host-oauth_state' : 'oauth_state';
}

interface AuthCookieOpts {
  httpOnly: true;
  secure: boolean;
  sameSite: 'Lax';
  path: '/';
}

export function authCookieOpts(secure: boolean): AuthCookieOpts {
  return { httpOnly: true, secure, sameSite: 'Lax', path: '/' };
}

// The helpers below accept any Hono context regardless of its env typing.
type AnyContext = Context<any>;

/** Read an auth cookie, preferring the __Host- name with legacy fallback. */
export function readAuthCookie(c: AnyContext, name: (secure: boolean) => string): string | undefined {
  const secure = isSecureRequest(c.req.raw);
  return getCookie(c, name(secure)) ?? (secure ? getCookie(c, name(false)) : undefined);
}

export function setAuthCookie(c: AnyContext, name: (secure: boolean) => string, value: string, maxAge: number): void {
  const secure = isSecureRequest(c.req.raw);
  setCookie(c, name(secure), value, { ...authCookieOpts(secure), maxAge });
  // Drop the legacy unprefixed cookie so stale copies can't shadow the new one.
  if (secure) deleteCookie(c, name(false), { path: '/' });
}

export function clearAuthCookie(c: AnyContext, name: (secure: boolean) => string): void {
  const secure = isSecureRequest(c.req.raw);
  if (secure) deleteCookie(c, name(true), { path: '/', secure: true });
  deleteCookie(c, name(false), { path: '/' });
}
