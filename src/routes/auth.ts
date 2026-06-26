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
import { signJWT, verifyJWT } from '../security/jwt';
import { generateCodeVerifier, generateCodeChallenge, generateState } from '../utils/pkce';
import { rateLimitByIP } from '../middleware/rate-limit';
import {
  accessCookieName,
  clearAuthCookie,
  isSecureRequest,
  oauthStateCookieName,
  readAuthCookie,
  refreshCookieName,
  setAuthCookie,
} from '../security/cookies';
import { normalizeRoles } from '../utils/roles';
import { viewRevision } from '../utils/view-revision';
import { loginPage } from '../templates/login';
import type { Env, Variables, JWTPayload } from '../types';
import {
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  capUserSessions,
  issueAuthTokens,
  purgeExpiredSessions,
  revokeRefreshSession,
  rotateAuthSession,
  storeRefreshSession,
} from '../security/sessions';

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
  role?: string;
}

interface OAuthStatePayload extends JWTPayload {
  state?: string;
  code_verifier?: string;
  provider?: string;
}

/** True when no allowlist is configured or the email's domain is listed. */
function isEmailAllowed(env: Env, email: string): boolean {
  const allowed = (env.ALLOWED_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  return allowed.includes(domain);
}

/** Returns the enabled providers in declaration order. */
function getEnabledProviders(env: Env): string[] {
  return (env.ENABLED_PROVIDERS ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p in PROVIDERS);
}

/** Returns the client ID and secret for the given provider. */
function getProviderCredentials(
  env: Env,
  provider: string,
): { clientId: string; clientSecret: string } | null {
  if (provider === 'github' && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (provider === 'google' && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  if (provider === 'eventuai' && env.EVENTUAI_CLIENT_ID && env.EVENTUAI_CLIENT_SECRET) {
    return { clientId: env.EVENTUAI_CLIENT_ID, clientSecret: env.EVENTUAI_CLIENT_SECRET };
  }
  return null;
}

function normalizeUser(provider: string, data: Record<string, unknown>): NormalizedUser | null {
  if (provider === 'eventuai') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string' ? data['email'] : '';
    if (!sub || !email) return null;

    const roles = Array.isArray(data['roles'])
      ? data['roles'].filter((role): role is string => typeof role === 'string')
      : [];
    return {
      oauthId: `eventuai:${sub}`,
      email,
      name: String(data['preferred_username'] ?? sub),
      avatarUrl: '',
      role: normalizeRoles(roles),
    };
  }
  if (provider === 'google') {
    const sub = typeof data['sub'] === 'string' ? data['sub'] : '';
    const email = typeof data['email'] === 'string' ? data['email'] : '';
    if (!sub || !email) return null;

    return {
      oauthId: `google:${sub}`,
      email,
      name: String(data['name'] ?? ''),
      avatarUrl: String(data['picture'] ?? ''),
    };
  }
  const id = data['id'];
  if (typeof id !== 'string' && typeof id !== 'number') return null;

  // GitHub (default)
  return {
    oauthId: `github:${id}`,
    email: String(data['email'] ?? `${data['login']}@github.noreply`),
    name: String(data['name'] ?? data['login'] ?? ''),
    avatarUrl: String(data['avatar_url'] ?? ''),
  };
}

// ── Route handlers ─────────────────────────────────────────────────────────────

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

// Throttle the endpoints involved in credential issuance.
const authRateLimit = rateLimitByIP((env) => env.AUTH_RATE_LIMITER);
authRoutes.use('/start', authRateLimit);
authRoutes.use('/callback', authRateLimit);
authRoutes.use('/refresh', authRateLimit);

// GET /auth/login – show the login page (HTML)
authRoutes.get('/login', async (c) => {
  const providers = getEnabledProviders(c.env);
  const error = c.req.query('error');
  return c.html(
    await loginPage(c.env.VIEWS, {
      siteTitle: c.env.SITE_TITLE ?? '0xCMS',
      providers: providers.length > 0 ? providers : ['github'],
      error,
      viewRevision: viewRevision(c.env),
    }),
  );
});

// GET /auth/start?provider=<name> – initiate OAuth 2.1 flow with PKCE
authRoutes.get('/start', async (c) => {
  const enabledProviders = getEnabledProviders(c.env);
  // Accept the provider from the query string; fall back to the first enabled one.
  const requested = c.req.query('provider')?.toLowerCase() ?? '';
  const providerName = enabledProviders.includes(requested)
    ? requested
    : enabledProviders[0] ?? 'github';

  const providerConfig = PROVIDERS[providerName];
  if (!providerConfig) {
    return c.text(`Unsupported OAuth provider: ${providerName}`, 500);
  }

  const credentials = getProviderCredentials(c.env, providerName);
  if (!credentials) {
    return c.text(`OAuth credentials not configured for provider: ${providerName}`, 500);
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store PKCE state (including the chosen provider) in a signed short-lived
  // JWT cookie so we have no server-side storage dependency.
  const statePayload = {
    sub: 'pkce',
    email: '',
    name: '',
    role: 'viewer',
    type: 'access' as const,
    state,
    code_verifier: codeVerifier,
    provider: providerName,
    exp: Math.floor(Date.now() / 1000) + 600, // 10 minutes
  };
  const stateCookie = await signJWT(statePayload, c.env.JWT_SECRET);
  const secureCookie = isSecureRequest(c.req.raw);
  // __Host- requires Path=/; SameSite=None so the cookie is sent on the
  // cross-site top-level redirect back from the OAuth provider.
  setCookie(c, oauthStateCookieName(secureCookie), stateCookie, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: secureCookie ? 'None' : 'Lax',
    path: '/',
    maxAge: 600,
  });

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: c.env.OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: providerConfig.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return c.redirect(`${providerConfig.authUrl}?${params.toString()}`);
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

  // Verify PKCE state cookie (legacy unprefixed name accepted for one release)
  const secureCookie = isSecureRequest(c.req.raw);
  const stateCookie = getCookie(c, oauthStateCookieName(secureCookie))
    ?? (secureCookie ? getCookie(c, oauthStateCookieName(false)) : undefined)
    ?? getCookie(c, 'oauth_state');
  deleteCookie(c, oauthStateCookieName(secureCookie), {
    secure: secureCookie,
    sameSite: secureCookie ? 'None' : 'Lax',
    path: '/',
  });
  deleteCookie(c, 'oauth_state', { path: '/auth' });
  if (!stateCookie) {
    return c.redirect('/auth/login?error=missing_state');
  }

  const statePayload = await verifyJWT(stateCookie, c.env.JWT_SECRET) as OAuthStatePayload | null;
  if (!statePayload) {
    return c.redirect('/auth/login?error=invalid_state');
  }

  const storedState = statePayload.state;
  const codeVerifier = statePayload.code_verifier;

  if (!storedState || !codeVerifier || storedState !== state) {
    return c.redirect('/auth/login?error=state_mismatch');
  }

  const providerName = statePayload.provider ?? '';
  const providerConfig = PROVIDERS[providerName];
  if (!providerConfig) {
    return c.redirect('/auth/login?error=unsupported_provider');
  }

  const credentials = getProviderCredentials(c.env, providerName);
  if (!credentials) {
    return c.redirect('/auth/login?error=provider_not_configured');
  }

  // Exchange code for provider access token
  const tokenRes = await fetch(providerConfig.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
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
  const userRes = await fetch(providerConfig.userUrl, {
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
  if (!normalized) {
    return c.redirect('/auth/login?error=invalid_userinfo');
  }

  // Optional registration allowlist: when ALLOWED_EMAIL_DOMAINS is set, only
  // matching emails may create a new account. Existing users always pass so a
  // config change can never lock out current accounts.
  if (!isEmailAllowed(c.env, normalized.email)) {
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE oauth_id = ?')
      .bind(normalized.oauthId)
      .first<{ id: number }>();
    if (!existing) {
      return c.redirect('/auth/login?error=email_not_allowed');
    }
  }

  // Upsert user in DB; sync role when the identity provider supplies one
  if (normalized.role) {
    await c.env.DB.prepare(
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
    await c.env.DB.prepare(
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

  const dbUser = await c.env.DB.prepare(
    'SELECT id, email, name, role FROM users WHERE oauth_id = ?',
  )
    .bind(normalized.oauthId)
    .first<{ id: number; email: string; name: string; role: string }>();

  if (!dbUser) {
    return c.redirect('/auth/login?error=db_error');
  }

  const issued = await issueAuthTokens(dbUser, c.env.JWT_SECRET);
  await storeRefreshSession(c.env.DB, dbUser.id, issued.refreshJti);

  // Session hygiene: cap concurrent sessions per user and purge expired rows.
  c.executionCtx.waitUntil(Promise.all([
    capUserSessions(c.env.DB, dbUser.id),
    purgeExpiredSessions(c.env.DB),
  ]));

  setAuthCookie(c, accessCookieName, issued.accessToken, ACCESS_TOKEN_TTL);
  setAuthCookie(c, refreshCookieName, issued.refreshToken, REFRESH_TOKEN_TTL);

  return c.redirect('/admin');
});

// POST /auth/logout – revoke session and clear cookies.
// Logout is a state change: POST only, protected by the global
// cross-site mutation check in index.ts.
authRoutes.post('/logout', async (c) => {
  const refreshToken = readAuthCookie(c, refreshCookieName);
  if (refreshToken) {
    await revokeRefreshSession(c.env.DB, c.env.JWT_SECRET, refreshToken);
  }

  clearAuthCookie(c, accessCookieName);
  clearAuthCookie(c, refreshCookieName);

  return c.redirect('/auth/login');
});

authRoutes.get('/logout', (c) => c.text('Method Not Allowed', 405));

// POST /auth/refresh – programmatic silent refresh (JSON)
authRoutes.post('/refresh', async (c) => {
  const refreshToken = readAuthCookie(c, refreshCookieName);
  if (!refreshToken) {
    return c.json({ error: 'no_refresh_token' }, 401);
  }

  const rotated = await rotateAuthSession(c.env.DB, c.env.JWT_SECRET, refreshToken);
  if (!rotated.ok) {
    return c.json({ error: rotated.error }, 401);
  }

  // Opportunistic hygiene: purge expired sessions without blocking the response.
  c.executionCtx.waitUntil(purgeExpiredSessions(c.env.DB));

  setAuthCookie(c, accessCookieName, rotated.accessToken, ACCESS_TOKEN_TTL);
  setAuthCookie(c, refreshCookieName, rotated.refreshToken, REFRESH_TOKEN_TTL);

  return c.json({ ok: true, expires_in: ACCESS_TOKEN_TTL });
});
