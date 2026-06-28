import { Hono } from 'hono';
import { profilePage } from '../../templates/profile';
import type { Env, Variables, User } from '../../types';
import { renderPage } from '../../utils/admin-render';
import { ROLE_LABELS } from '../../utils/roles';
import { allRoleOptions } from '../../utils/role-store';

export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

interface OAuthIdentityRow {
  provider: string;
  provider_user_id: string;
  oauth_id: string;
}

const KNOWN_PROVIDERS = ['eventuai', 'github', 'google', 'microsoft', 'apple'] as const;

function providerLabel(provider: string): string {
  if (provider === 'eventuai') return 'Eventuai';
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function enabledProviders(env: Env): string[] {
  const known = new Set<string>(KNOWN_PROVIDERS);
  return (env.ENABLED_PROVIDERS ?? '')
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => known.has(provider));
}

function splitOAuthId(oauthId: string): { provider: string; providerUserId: string } {
  const index = oauthId.indexOf(':');
  if (index === -1) return { provider: 'legacy', providerUserId: oauthId };
  return { provider: oauthId.slice(0, index), providerUserId: oauthId.slice(index + 1) };
}

function roleLabel(role: string, options: Array<{ name: string; label: string }>): string {
  const byName = new Map(options.map((option) => [option.name, option.label]));
  return role
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => byName.get(name) ?? ROLE_LABELS[name as keyof typeof ROLE_LABELS] ?? name)
    .join(', ');
}

profileRoutes.get('/profile', async (c) => {
  const userId = Number(c.get('user').sub);
  const [user, identityRows, roleOptions] = await Promise.all([
    c.env.DB.prepare('SELECT id, oauth_id, email, name, avatar_url, role FROM users WHERE id = ?')
      .bind(userId)
      .first<User>(),
    c.env.DB.prepare(
      `SELECT provider, provider_user_id, oauth_id
         FROM user_oauth_identities
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(userId)
      .all<OAuthIdentityRow>(),
    allRoleOptions(c.env),
  ]);
  if (!user) return c.notFound();

  const byOAuthId = new Map<string, OAuthIdentityRow>();
  for (const identity of identityRows.results) {
    byOAuthId.set(identity.oauth_id, identity);
  }
  if (user.oauth_id && !byOAuthId.has(user.oauth_id)) {
    const fallback = splitOAuthId(user.oauth_id);
    byOAuthId.set(user.oauth_id, {
      provider: fallback.provider,
      provider_user_id: fallback.providerUserId,
      oauth_id: user.oauth_id,
    });
  }

  const identities = Array.from(byOAuthId.values()).map((identity) => ({
    provider: identity.provider,
    label: providerLabel(identity.provider),
    providerUserId: identity.provider_user_id,
    connected: true,
  }));
  const connected = new Set(identities.map((identity) => identity.provider));
  const providers = enabledProviders(c.env).map((provider) => ({
    provider,
    label: providerLabel(provider),
    connected: connected.has(provider),
    connectHref: `/auth/start?provider=${encodeURIComponent(provider)}&link=1`,
  }));

  return renderPage(c, profilePage, {
    name: user.name,
    email: user.email,
    roleLabel: roleLabel(user.role, roleOptions),
    avatarUrl: user.avatar_url ?? '',
    identities,
    providers,
  });
});
