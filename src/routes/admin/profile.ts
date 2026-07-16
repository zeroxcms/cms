import { Hono } from 'hono';
import { profilePage } from '../../templates/profile';
import type { Env, Variables, User } from '../../types';
import { renderPage } from '../../utils/admin-render';
import { ROLE_LABELS, splitRoles } from '../../utils/roles';
import { allRoleOptions } from '../../utils/role-store';
import { countCreditLedger, donateSharedCredits, getSharedCreditBalance, listCreditLedger, transferCredits } from '../../utils/credits';
import { creditLedgerRowForView } from '../../templates/users';
import { logAudit } from '../../utils/audit';
import { localeRegistry, resolveUiLocale, setUiLocaleCookie } from '../../utils/i18n';

const CREDIT_TRANSFER_ACTION = '/admin/profile/credits/transfer';
const SHARED_DONATE_ACTION = '/admin/profile/credits/shared';

export const profileRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const CREDIT_LEDGER_PAGE_SIZE = 20;

interface OAuthIdentityRow {
  id: number;
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

function positivePage(value: string | undefined): number {
  const page = Number(value ?? '1');
  return Number.isInteger(page) && page > 0 ? page : 1;
}

function profileCreditPageHref(page: number): string {
  if (page <= 1) return '/admin/profile';
  return `/admin/profile?credit_page=${page}`;
}

profileRoutes.get('/profile', async (c) => {
  const userId = Number(c.get('user').sub);
  const flash = c.req.query('flash') ?? '';
  const error = c.req.query('error') ?? '';
  const requestedCreditPage = positivePage(c.req.query('credit_page'));
  const [user, identityRows, roleOptions, creditLedgerTotal, registry, currentUiLocale] = await Promise.all([
    c.env.DB.prepare('SELECT id, oauth_id, email, name, avatar_url, role, credits FROM users WHERE id = ?')
      .bind(userId)
      .first<User>(),
    c.env.DB.prepare(
      `SELECT id, provider, provider_user_id, oauth_id
         FROM user_oauth_identities
        WHERE user_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
      .bind(userId)
      .all<OAuthIdentityRow>(),
    allRoleOptions(c.env),
    countCreditLedger(c.env, userId),
    localeRegistry(c.env),
    resolveUiLocale(c),
  ]);
  if (!user) return c.notFound();
  const creditPageCount = Math.max(1, Math.ceil(creditLedgerTotal / CREDIT_LEDGER_PAGE_SIZE));
  const creditPage = Math.min(requestedCreditPage, creditPageCount);
  const creditLedger = await listCreditLedger(c.env, userId, {
    limit: CREDIT_LEDGER_PAGE_SIZE,
    offset: (creditPage - 1) * CREDIT_LEDGER_PAGE_SIZE,
  });
  const sharedCreditBalance = await getSharedCreditBalance(c.env);

  const byOAuthId = new Map<string, OAuthIdentityRow>();
  for (const identity of identityRows.results) {
    byOAuthId.set(identity.oauth_id, identity);
  }
  if (user.oauth_id && !byOAuthId.has(user.oauth_id)) {
    const fallback = splitOAuthId(user.oauth_id);
    byOAuthId.set(user.oauth_id, {
      id: 0,
      provider: fallback.provider,
      provider_user_id: fallback.providerUserId,
      oauth_id: user.oauth_id,
    });
  }

  const identityCount = byOAuthId.size;
  const identities = Array.from(byOAuthId.values()).map((identity) => ({
    id: String(identity.id),
    provider: identity.provider,
    label: providerLabel(identity.provider),
    providerUserId: identity.provider_user_id,
    disconnectHref: `/admin/profile/identities/${identity.id}/disconnect`,
    canDisconnect: identity.id > 0 && identityCount > 1,
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
    flash,
    error,
    identities,
    providers,
    creditBalance: user.credits ?? 0,
    creditTransferAction: CREDIT_TRANSFER_ACTION,
    sharedCreditBalance,
    sharedDonateAction: SHARED_DONATE_ACTION,
    creditLedger: creditLedger.map(creditLedgerRowForView),
    creditLedgerPagination: {
      page: creditPage,
      pageCount: creditPageCount,
      total: creditLedgerTotal,
      from: creditLedgerTotal === 0 ? 0 : ((creditPage - 1) * CREDIT_LEDGER_PAGE_SIZE) + 1,
      to: Math.min(creditPage * CREDIT_LEDGER_PAGE_SIZE, creditLedgerTotal),
      hasPrevious: creditPage > 1,
      previousHref: profileCreditPageHref(creditPage - 1),
      hasNext: creditPage < creditPageCount,
      nextHref: profileCreditPageHref(creditPage + 1),
    },
    uiLocaleOptions: registry.uiLocales.map((locale) => ({
      code: locale.code,
      label: locale.label,
      selected: locale.code === currentUiLocale.code,
    })),
    uiLocaleAction: '/admin/profile/locale',
  });
});

profileRoutes.post('/profile/locale', async (c) => {
  const form = await c.req.formData();
  const requested = String(form.get('locale') ?? '');
  const { uiLocales } = await localeRegistry(c.env);
  if (!uiLocales.some((locale) => locale.code === requested)) {
    return c.redirect('/admin/profile?error=Interface+language+is+not+enabled', 303);
  }
  setUiLocaleCookie(c, requested);
  return c.redirect('/admin/profile?flash=Interface+language+saved', 303);
});

// Send credits to another user. Recipients are looked up by email and must be
// a different, non-admin user (admins manage credits via the users admin, not
// by receiving transfers). The move is atomic and overdraft-guarded in
// transferCredits — a balance can never go below zero.
profileRoutes.post('/profile/credits/transfer', async (c) => {
  const userId = Number(c.get('user').sub);
  const back = '/admin/profile';
  const form = await c.req.formData();
  const email = String(form.get('recipient') ?? '').trim().toLowerCase();
  const amount = Math.trunc(Number(form.get('amount')));
  const note = String(form.get('note') ?? '').trim().slice(0, 300);

  if (!email) return c.redirect(`${back}?error=Enter+the+recipient+email`);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.redirect(`${back}?error=Enter+a+positive+amount`);
  }

  const recipient = await c.env.DB.prepare(
    'SELECT id, email, role FROM users WHERE lower(email) = ?',
  ).bind(email).first<Pick<User, 'id' | 'email' | 'role'>>();
  if (!recipient) return c.redirect(`${back}?error=No+user+with+that+email`);
  if (recipient.id === userId) {
    return c.redirect(`${back}?error=You+cannot+send+credits+to+yourself`);
  }
  if (splitRoles(recipient.role).includes('admin')) {
    return c.redirect(`${back}?error=Credits+cannot+be+sent+to+an+administrator`);
  }

  const result = await transferCredits(c.env, {
    fromUserId: userId,
    toUserId: recipient.id,
    amount,
    note: note || undefined,
    createdBy: c.get('user').sub,
  });
  if (!result.ok) {
    return c.redirect(result.error === 'insufficient_credits'
      ? `${back}?error=Not+enough+credits+(balance+${result.balance})`
      : `${back}?error=Transfer+failed`);
  }

  logAudit(c, 'user.credits.transfer', 'user', recipient.id, {
    amount, from: userId, balance_after: result.senderBalance,
  });
  return c.redirect(`${back}?flash=${encodeURIComponent(`Sent ${amount} credits to ${recipient.email}`)}`);
});

// Donate credits from your OWN balance into the shared pool. The pool is for
// all users (it covers charged actions when someone's balance runs out), so
// there is no recipient to pick and no permission needed — the donation is
// overdraft-guarded like any spend and ledger-audited on both sides
// ('shared:donate'). Moving credits OUT of the pool to a user is the
// privileged direction, gated by 'credits:share' in the users admin.
profileRoutes.post('/profile/credits/shared', async (c) => {
  const userId = Number(c.get('user').sub);
  const back = '/admin/profile';
  const form = await c.req.formData();
  const amount = Math.trunc(Number(form.get('amount')));
  const note = String(form.get('note') ?? '').trim().slice(0, 300);

  if (!Number.isFinite(amount) || amount <= 0) {
    return c.redirect(`${back}?error=Enter+a+positive+amount`);
  }

  const result = await donateSharedCredits(c.env, {
    fromUserId: userId,
    amount,
    note: note || undefined,
    createdBy: c.get('user').sub,
  });
  if (!result.ok) {
    return c.redirect(result.error === 'insufficient_credits'
      ? `${back}?error=Not+enough+credits+(balance+${result.balance})`
      : `${back}?error=Donation+failed`);
  }

  logAudit(c, 'user.credits.donate', 'user', userId, {
    amount, balance_after: result.balanceAfter, shared_balance_after: result.sharedBalance,
  });
  return c.redirect(`${back}?flash=${encodeURIComponent(`Moved ${amount} credits into the shared pool`)}`);
});

profileRoutes.post('/profile/identities/:id/disconnect', async (c) => {
  const userId = Number(c.get('user').sub);
  const identityId = Number(c.req.param('id'));
  if (!Number.isInteger(identityId) || identityId <= 0) {
    return c.redirect('/admin/profile?error=Invalid+identity');
  }

  const identity = await c.env.DB.prepare(
    'SELECT id, user_id, oauth_id FROM user_oauth_identities WHERE id = ? AND user_id = ?',
  )
    .bind(identityId, userId)
    .first<{ id: number; user_id: number; oauth_id: string }>();
  if (!identity) {
    return c.redirect('/admin/profile?error=Identity+not+found');
  }

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM user_oauth_identities WHERE user_id = ?',
  )
    .bind(userId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) <= 1) {
    return c.redirect('/admin/profile?error=At+least+one+sign-in+method+is+required');
  }

  const user = await c.env.DB.prepare('SELECT oauth_id FROM users WHERE id = ?')
    .bind(userId)
    .first<{ oauth_id: string }>();
  if (user?.oauth_id === identity.oauth_id) {
    const replacement = await c.env.DB.prepare(
      `SELECT oauth_id
         FROM user_oauth_identities
        WHERE user_id = ? AND id != ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    )
      .bind(userId, identityId)
      .first<{ oauth_id: string }>();
    if (!replacement) {
      return c.redirect('/admin/profile?error=At+least+one+sign-in+method+is+required');
    }
    await c.env.DB.prepare('UPDATE users SET oauth_id = ? WHERE id = ?')
      .bind(replacement.oauth_id, userId)
      .run();
  }

  await c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE id = ? AND user_id = ?')
    .bind(identityId, userId)
    .run();

  return c.redirect('/admin/profile?flash=Sign-in+method+disconnected');
});
