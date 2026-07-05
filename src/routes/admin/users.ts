// User administration — list users and assign their roles. Admin-gated
// (users:manage). Users are created by OAuth login, not here.

import { Hono } from 'hono';
import { usersPage, userFormPage } from '../../templates/users';
import type { Env, Variables, User } from '../../types';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { renderPage } from '../../utils/admin-render';
import { allRoleOptions } from '../../utils/role-store';
import { ROLE_LABELS } from '../../utils/roles';
import { adjustCredits, listCreditLedger } from '../../utils/credits';
import { creditLedgerRowForView } from '../../templates/users';
import type { AppContext } from '../../utils/context';

export const usersRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

usersRoutes.use('/users', requirePermission('users:manage'));
usersRoutes.use('/users/*', requirePermission('users:manage'));

interface UserListRow extends User {
  oauth_id: string;
}

interface UserIdentityProviderRow {
  user_id: number;
  provider: string;
}

function rolesLabel(role: string, options: Array<{ name: string; label: string }>): string {
  const byName = new Map(options.map((option) => [option.name, option.label]));
  return role
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => byName.get(name) ?? ROLE_LABELS[name as keyof typeof ROLE_LABELS] ?? name)
    .join(', ');
}

function hasAdminRole(role: string): boolean {
  return role.split(',').map((r) => r.trim()).includes('admin');
}

function providerFromOAuthId(oauthId: string): string {
  const index = oauthId.indexOf(':');
  return index === -1 ? 'legacy' : oauthId.slice(0, index);
}

function providerLabel(provider: string): string {
  if (provider === 'eventuai') return 'Eventuai';
  if (provider === 'github') return 'GitHub';
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  if (provider === 'legacy') return 'Legacy';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

usersRoutes.get('/users', async (c) => {
  const currentUserId = Number(c.get('user').sub);
  const [users, identities, options, adminCount] = await Promise.all([
    c.env.DB.prepare('SELECT id, oauth_id, name, email, role FROM users ORDER BY name ASC, email ASC').all<UserListRow>(),
    c.env.DB.prepare(
      `SELECT user_id, provider
         FROM user_oauth_identities
        ORDER BY created_at ASC, id ASC`,
    ).all<UserIdentityProviderRow>(),
    allRoleOptions(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .first<{ n: number }>(),
  ]);
  const providersByUser = new Map<number, string[]>();
  for (const identity of identities.results) {
    const providers = providersByUser.get(identity.user_id) ?? [];
    if (!providers.includes(identity.provider)) providers.push(identity.provider);
    providersByUser.set(identity.user_id, providers);
  }

  return renderPage(c, usersPage, {
    users: users.results.map((user) => {
      const providers = [...(providersByUser.get(user.id) ?? [])];
      const fallbackProvider = providerFromOAuthId(user.oauth_id);
      if (fallbackProvider && !providers.includes(fallbackProvider)) providers.push(fallbackProvider);
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        identityProviders: providers.map((provider) => ({ provider, label: providerLabel(provider) })),
        rolesLabel: rolesLabel(user.role, options),
        editHref: `/admin/users/${user.id}/edit`,
        deleteAction: `/admin/users/${user.id}/delete`,
        canDelete: user.id !== currentUserId && (!hasAdminRole(user.role) || (adminCount?.n ?? 0) > 1),
      };
    }),
    flash: c.req.query('flash') ?? '',
    error: c.req.query('error') ?? '',
  });
});

usersRoutes.get('/users/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role, credits FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();
  return userForm(c, user, c.req.query('error') || undefined, c.req.query('flash') || undefined);
});

// Grant or deduct credits with a mandatory note. Deductions use the same
// overdraft guard as spends — a balance can never be adjusted below zero.
usersRoutes.post('/users/:id/credits', requirePermission('users:manage'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();

  const form = await c.req.formData();
  const amount = Math.trunc(Number(form.get('amount')));
  const note = String(form.get('note') ?? '').trim().slice(0, 300);
  const back = `/admin/users/${id}/edit`;
  if (!Number.isFinite(amount) || amount === 0) {
    return c.redirect(`${back}?error=Enter+a+non-zero+amount`);
  }
  if (!note) {
    return c.redirect(`${back}?error=A+note+is+required+for+credit+adjustments`);
  }

  const result = await adjustCredits(c.env, {
    userId: id,
    delta: amount,
    action: 'admin:adjust',
    note,
    createdBy: c.get('user').sub,
  });
  if (!result.ok) {
    return c.redirect(result.error === 'insufficient_credits'
      ? `${back}?error=Cannot+deduct+below+zero+(balance+${result.balance})`
      : `${back}?error=User+not+found`);
  }

  logAudit(c, 'user.credits.adjust', 'user', id, { amount, note, balance_after: result.balanceAfter });
  return c.redirect(`${back}?flash=Credits+updated+(balance+${result.balanceAfter})`);
});

usersRoutes.post('/users/:id', requirePermission('users:manage'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role, credits FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();

  const form = await c.req.formData();
  const options = await allRoleOptions(c.env);
  const valid = new Set(options.map((option) => option.name));
  const selected = [...new Set(form.getAll('roles').map(String).filter((role) => valid.has(role)))];
  const nextRole = selected.length ? selected.join(',') : 'viewer';

  // Lockout guard: never let the last admin lose the admin role.
  const losesAdmin = user.role.split(',').map((r) => r.trim()).includes('admin') && !selected.includes('admin');
  if (losesAdmin) {
    const otherAdmins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .bind(id)
      .first<{ n: number }>();
    if ((otherAdmins?.n ?? 0) === 0) {
      return userForm(c, user, 'Cannot remove the admin role from the last administrator.');
    }
  }

  await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(nextRole, id).run();
  logAudit(c, 'user.roles', 'user', id, { role: nextRole });
  return c.redirect('/admin/users');
});

usersRoutes.post('/users/:id/delete', requirePermission('users:manage'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const currentUserId = Number(c.get('user').sub);
  if (!Number.isInteger(id) || id <= 0) return c.notFound();
  if (id === currentUserId) {
    return c.redirect('/admin/users?error=You+cannot+remove+your+own+user');
  }

  const user = await c.env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?')
    .bind(id)
    .first<Pick<User, 'id' | 'email' | 'role'>>();
  if (!user) return c.notFound();

  if (hasAdminRole(user.role)) {
    const otherAdmins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id != ? AND (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .bind(id)
      .first<{ n: number }>();
    if ((otherAdmins?.n ?? 0) === 0) {
      return c.redirect('/admin/users?error=Cannot+remove+the+last+administrator');
    }
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM user_oauth_identities WHERE user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  logAudit(c, 'user.delete', 'user', id, { email: user.email });
  return c.redirect('/admin/users?flash=User+removed');
});

async function userForm(c: AppContext, user: User, error?: string, flash?: string): Promise<Response> {
  const [options, ledger] = await Promise.all([
    allRoleOptions(c.env),
    listCreditLedger(c.env, user.id, { limit: 10 }),
  ]);
  const held = new Set(user.role.split(',').map((role) => role.trim()).filter(Boolean));
  return renderPage(c, userFormPage, {
    id: user.id,
    name: user.name,
    email: user.email,
    error,
    flash,
    roleOptions: options.map((option) => ({ value: option.name, label: option.label, checked: held.has(option.name) })),
    creditBalance: user.credits ?? 0,
    creditAdjustAction: `/admin/users/${user.id}/credits`,
    creditLedger: ledger.map(creditLedgerRowForView),
  });
}
