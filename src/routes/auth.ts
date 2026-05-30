// ============================================================
// OAuth 2.1 routes
//   GET  /auth/login    – show the login page (HTML)
//   GET  /auth/start    – initiate OAuth flow (redirect to provider)
//   GET  /auth/callback – handle provider callback
//   GET  /auth/logout   – clear session
//   POST /auth/refresh  – programmatic token refresh (JSON API)
// ============================================================

import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { signJWT, verifyJWT, hashToken, generateTokenId } from '../utils/jwt';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../utils/pkce';
import { loginPage } from '../templates/login';
import type { Env, Variables, JWTPayload, UserRole } from '../types';

const ACCESS_TOKEN_TTL = 15 * 60;        // 15 minutes
const REFRESH_TOKEN_TTL = 7 * 24 * 3600; // 7 days

// ── OAuth provider config ─────────────────────────────────────────────────────

interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
}

const PROVIDERS: Record<string, OAuthProvider> = {
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user',
    scope: 'read:user user:email',
  },
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile',
  },
  eventuai: {
    authUrl: 'https://id.eventuai.com/oauth/authorize',
    tokenUrl: 'https://id.eventuai.com/oauth/token',
    userUrl: 'https://id.eventuai.com/oauth/userinfo',
    scope: 'openid profile email roles',
  },
};

interface NormalizedUser {
  oauthId: string;
  email: string;
  name: string;
  avatarUrl: string;
  role?: UserRole;
}

function mapRoleFromOAuth(roles: string[]): UserRole {
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('editor')) return 'editor';
  if (roles.includes('moderator')) return 'moderator';
  return 'viewer';
}

function normalizeUser(provider: string, data: Record<string, unknown>): NormalizedUser {
  if (provider === 'eventuai') {
    const roles = Array.isArray(data['roles']) ? (data['roles'] as string[]) : [];
    return {
      oauthId: `eventuai:${data['sub']}`,
      email: String(data['email'] ?? ''),
      name: String(data['preferred_username'] ?? data['sub'] ?? ''),
      avatarUrl: '',
      role: mapRoleFromOAuth(roles),
    };
  }
  if (provider === 'google') {
    return {
      oauthId: `google:${data['sub']}`,
      email: String(data['email'] ?? ''),
      name: String(data['name'] ?? ''),
      avatarUrl: String(data['picture'] ?? ''),
    };
  }
  // GitHub (default)
  return {
    oauthId: `github:${data['id']}`,
    email: String(data['email'] ?? `${data['login']}@github.noreply`),
    name: String(data['name'] ?? data['login'] ?? ''),
    avatarUrl: String(data['avatar_url'] ?? ''),
  };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /auth/login – show the login page (HTML)
authRoutes.get('/login', (c) => {
  const providerName = c.env.OAUTH_PROVIDER ?? 'github';
  const error = c.req.query('error');
  return c.html(
    loginPage({
      siteTitle: c.env.SITE_TITLE ?? 'Worker CMS',
      provider: providerName,
      error,
    }),
  );
});

// GET /auth/start – initiate OAuth 2.1 flow with PKCE
authRoutes.get('/start', async (c) => {
  const providerName = c.env.OAUTH_PROVIDER ?? 'github';
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return c.text(`Unsupported OAuth provider: ${providerName}`, 500);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store PKCE state in a signed short-lived JWT cookie so we have no
  // server-side storage dependency during the redirect round-trip.
  const statePayload = {
    sub: 'pkce',
    email: '',
    name: '',
    role: 'viewer' as UserRole,
    type: 'access' as const,
    state,
    code_verifier: codeVerifier,
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const stateCookie = await signJWT(statePayload, c.env.JWT_SECRET);
  setCookie(c, 'oauth_state', stateCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    path: '/auth',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: c.env.OAUTH_CLIENT_ID,
    redirect_uri: c.env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: provider.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${provider.authUrl}?${params.toString()}`);
});

// GET /auth/callback – handle the provider redirect
authRoutes.get('/callback', async (c) => {
  const { code, state, error } = c.req.query() as Record<string, string>;

  if (error) {
    return c.redirect(`/auth/login?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return c.redirect('/auth/login?error=missing_params');
  }

  // Verify PKCE state cookie
  const stateCookie = getCookie(c, 'oauth_state');
  deleteCookie(c, 'oauth_state', { path: '/auth' });
  if (!stateCookie) {
    return c.redirect('/auth/login?error=missing_state');
  }

  const statePayload = await verifyJWT(stateCookie, c.env.JWT_SECRET);
  if (!statePayload) {
    return c.redirect('/auth/login?error=invalid_state');
  }

  const storedState = (statePayload as unknown as Record<string, string>)['state'];
  const codeVerifier = (statePayload as unknown as Record<string, string>)['code_verifier'];

  if (storedState !== state) {
    return c.redirect('/auth/login?error=state_mismatch');
  }

  const providerName = c.env.OAUTH_PROVIDER ?? 'github';
  const provider = PROVIDERS[providerName];

  // Exchange code for provider access token
  const tokenRes = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: c.env.OAUTH_CLIENT_ID,
      client_secret: c.env.OAUTH_CLIENT_SECRET,
      code,
      redirect_uri: c.env.OAUTH_REDIRECT_URI,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    return c.redirect('/auth/login?error=token_exchange_failed');
  }

  const tokenData = await tokenRes.json<Record<string, string>>();
  const providerAccessToken = tokenData['access_token'];
  if (!providerAccessToken) {
    return c.redirect('/auth/login?error=no_access_token');
  }

  // Fetch user info from provider
  const userRes = await fetch(provider.userUrl, {
    headers: {
      Authorization: 'Bearer ' + providerAccessToken,
      Accept: 'application/json',
      'User-Agent': 'worker-cms/1.0',
    },
  });
  if (!userRes.ok) {
    return c.redirect('/auth/login?error=userinfo_failed');
  }

  const rawUser = await userRes.json<Record<string, unknown>>();
  const normalized = normalizeUser(providerName, rawUser);

  // Upsert user in AUTH DB; sync role when the identity provider supplies one
  if (normalized.role) {
    await c.env.AUTH_DB.prepare(
      `INSERT INTO users (oauth_id, email, name, avatar_url, role)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(oauth_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         avatar_url = excluded.avatar_url,
         role = excluded.role`,
    )
      .bind(normalized.oauthId, normalized.email, normalized.name, normalized.avatarUrl, normalized.role)
      .run();
  } else {
    await c.env.AUTH_DB.prepare(
      `INSERT INTO users (oauth_id, email, name, avatar_url)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(oauth_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         avatar_url = excluded.avatar_url`,
    )
      .bind(normalized.oauthId, normalized.email, normalized.name, normalized.avatarUrl)
      .run();
  }

  const dbUser = await c.env.AUTH_DB.prepare(
    'SELECT id, email, name, role FROM users WHERE oauth_id = ?',
  )
    .bind(normalized.oauthId)
    .first<{ id: number; email: string; name: string; role: UserRole }>();

  if (!dbUser) {
    return c.redirect('/auth/login?error=db_error');
  }

  // Issue dual JWT (access + refresh)
  const now = Math.floor(Date.now() / 1000);
  const jti = generateTokenId();

  const accessPayload: JWTPayload = {
    sub: String(dbUser.id),
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    type: 'access',
    exp: now + ACCESS_TOKEN_TTL,
    iat: now,
  };
  const refreshPayloadData: JWTPayload = {
    sub: String(dbUser.id),
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    type: 'refresh',
    jti,
    exp: now + REFRESH_TOKEN_TTL,
    iat: now,
  };

  const [accessToken, refreshToken] = await Promise.all([
    signJWT(accessPayload, c.env.JWT_SECRET),
    signJWT(refreshPayloadData, c.env.JWT_SECRET),
  ]);

  // Store hashed jti in sessions table
  const tokenHash = await hashToken(jti);
  await c.env.AUTH_DB.prepare(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+7 days'))`,
  )
    .bind(dbUser.id, tokenHash)
    .run();

  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: 'Lax' as const,
    path: '/',
  };
  setCookie(c, 'access_token', accessToken, {
    ...cookieOpts,
    maxAge: ACCESS_TOKEN_TTL,
  });
  setCookie(c, 'refresh_token', refreshToken, {
    ...cookieOpts,
    maxAge: REFRESH_TOKEN_TTL,
  });

  return c.redirect('/admin');
});

// GET /auth/logout – revoke session and clear cookies
authRoutes.get('/logout', async (c) => {
  const refreshToken = getCookie(c, 'refresh_token');
  if (refreshToken) {
    const payload = await verifyJWT(refreshToken, c.env.JWT_SECRET);
    if (payload?.jti) {
      const tokenHash = await hashToken(payload.jti);
      await c.env.AUTH_DB.prepare(
        'DELETE FROM sessions WHERE refresh_token_hash = ?',
      )
        .bind(tokenHash)
        .run();
    }
  }

  deleteCookie(c, 'access_token', { path: '/' });
  deleteCookie(c, 'refresh_token', { path: '/' });

  return c.redirect('/auth/login');
});

// POST /auth/refresh – programmatic silent refresh (JSON)
authRoutes.post('/refresh', async (c) => {
  const refreshToken = getCookie(c, 'refresh_token');
  if (!refreshToken) {
    return c.json({ error: 'no_refresh_token' }, 401);
  }

  const refreshPayload = await verifyJWT(refreshToken, c.env.JWT_SECRET);
  if (!refreshPayload || refreshPayload.type !== 'refresh' || !refreshPayload.jti) {
    return c.json({ error: 'invalid_refresh_token' }, 401);
  }

  const tokenHash = await hashToken(refreshPayload.jti);
  const session = await c.env.AUTH_DB.prepare(
    'SELECT id, user_id FROM sessions WHERE refresh_token_hash = ? AND expires_at > CURRENT_TIMESTAMP',
  )
    .bind(tokenHash)
    .first<{ id: number; user_id: number }>();

  if (!session) {
    return c.json({ error: 'session_revoked' }, 401);
  }

  const dbUser = await c.env.AUTH_DB.prepare(
    'SELECT id, email, name, role FROM users WHERE id = ?',
  )
    .bind(session.user_id)
    .first<{ id: number; email: string; name: string; role: UserRole }>();

  if (!dbUser) {
    return c.json({ error: 'user_not_found' }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const newJti = generateTokenId();

  const accessPayload: JWTPayload = {
    sub: String(dbUser.id),
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    type: 'access',
    exp: now + ACCESS_TOKEN_TTL,
    iat: now,
  };
  const newRefreshPayload: JWTPayload = {
    sub: String(dbUser.id),
    email: dbUser.email,
    name: dbUser.name,
    role: dbUser.role,
    type: 'refresh',
    jti: newJti,
    exp: now + REFRESH_TOKEN_TTL,
    iat: now,
  };

  const [newAccessToken, newRefreshToken] = await Promise.all([
    signJWT(accessPayload, c.env.JWT_SECRET),
    signJWT(newRefreshPayload, c.env.JWT_SECRET),
  ]);

  const newTokenHash = await hashToken(newJti);
  await c.env.AUTH_DB.prepare(
    `UPDATE sessions SET refresh_token_hash = ?, expires_at = datetime('now', '+7 days') WHERE id = ?`,
  )
    .bind(newTokenHash, session.id)
    .run();

  const cookieOpts = {
    httpOnly: true,
    secure: true,
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

  return c.json({ ok: true, expires_in: ACCESS_TOKEN_TTL });
});
