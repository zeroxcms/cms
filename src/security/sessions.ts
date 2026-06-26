import type { JWTPayload } from '../types';
import { generateTokenId, hashToken, signJWT, verifyJWT } from './jwt';

export const ACCESS_TOKEN_TTL = 15 * 60;        // 15 minutes
export const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days
export const MAX_SESSIONS_PER_USER = 5;

export interface AuthDbUser {
  id: number;
  email: string;
  name: string;
  role: string;
}

export interface IssuedAuthTokens {
  accessPayload: JWTPayload;
  accessToken: string;
  refreshToken: string;
  refreshJti: string;
}

export type RotateAuthSessionResult =
  | {
      ok: true;
      accessPayload: JWTPayload;
      accessToken: string;
      refreshToken: string;
    }
  | { ok: false; error: 'invalid_refresh_token' | 'session_revoked' | 'user_not_found' };

export async function issueAuthTokens(user: AuthDbUser, jwtSecret: string): Promise<IssuedAuthTokens> {
  const now = Math.floor(Date.now() / 1000);
  const refreshJti = generateTokenId();
  const accessPayload = authPayload(user, 'access', now + ACCESS_TOKEN_TTL, now);
  const refreshPayload = authPayload(user, 'refresh', now + REFRESH_TOKEN_TTL, now, refreshJti);
  const [accessToken, refreshToken] = await Promise.all([
    signJWT(accessPayload, jwtSecret),
    signJWT(refreshPayload, jwtSecret),
  ]);

  return { accessPayload, accessToken, refreshToken, refreshJti };
}

export async function storeRefreshSession(db: D1Database, userId: number, refreshJti: string): Promise<void> {
  await db.prepare(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+7 days'))`,
  )
    .bind(userId, await hashToken(refreshJti))
    .run();
}

export async function rotateAuthSession(
  db: D1Database,
  jwtSecret: string,
  refreshToken: string,
): Promise<RotateAuthSessionResult> {
  const refreshPayload = await verifyJWT(refreshToken, jwtSecret);
  if (!refreshPayload || refreshPayload.type !== 'refresh' || !refreshPayload.jti) {
    return { ok: false, error: 'invalid_refresh_token' };
  }

  const session = await db.prepare(
    'SELECT id, user_id FROM sessions WHERE refresh_token_hash = ? AND expires_at > CURRENT_TIMESTAMP',
  )
    .bind(await hashToken(refreshPayload.jti))
    .first<{ id: number; user_id: number }>();

  if (!session) {
    return { ok: false, error: 'session_revoked' };
  }

  const user = await db.prepare(
    'SELECT id, email, name, role FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first<AuthDbUser>();

  if (!user) {
    return { ok: false, error: 'user_not_found' };
  }

  const issued = await issueAuthTokens(user, jwtSecret);
  await db.prepare(
    `UPDATE sessions SET refresh_token_hash = ?, expires_at = datetime('now', '+7 days') WHERE id = ?`,
  )
    .bind(await hashToken(issued.refreshJti), session.id)
    .run();

  return {
    ok: true,
    accessPayload: issued.accessPayload,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
  };
}

export async function revokeRefreshSession(
  db: D1Database,
  jwtSecret: string,
  refreshToken: string,
): Promise<void> {
  const payload = await verifyJWT(refreshToken, jwtSecret);
  if (!payload?.jti) return;

  await db.prepare('DELETE FROM sessions WHERE refresh_token_hash = ?')
    .bind(await hashToken(payload.jti))
    .run();
}

export function capUserSessions(db: D1Database, userId: number): Promise<D1Result> {
  return db.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND id NOT IN (
       SELECT id FROM sessions WHERE user_id = ?1 ORDER BY id DESC LIMIT ?2
     )`,
  ).bind(userId, MAX_SESSIONS_PER_USER).run();
}

export function purgeExpiredSessions(db: D1Database): Promise<D1Result> {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();
}

function authPayload(
  user: AuthDbUser,
  type: 'access' | 'refresh',
  exp: number,
  iat: number,
  jti?: string,
): JWTPayload {
  return {
    sub: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role,
    type,
    jti,
    exp,
    iat,
  };
}
