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
import type { AppContext } from '../../utils/context';

export const usersRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

usersRoutes.use('/users', requirePermission('users:manage'));
usersRoutes.use('/users/*', requirePermission('users:manage'));

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

usersRoutes.get('/users', async (c) => {
  const currentUserId = Number(c.get('user').sub);
  const [users, options, adminCount] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, email, role FROM users ORDER BY name ASC, email ASC').all<User>(),
    allRoleOptions(c.env),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE (',' || replace(role, ' ', '') || ',') LIKE '%,admin,%'")
      .first<{ n: number }>(),
  ]);
  return renderPage(c, usersPage, {
    users: users.results.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      rolesLabel: rolesLabel(user.role, options),
      editHref: `/admin/users/${user.id}/edit`,
      deleteAction: `/admin/users/${user.id}/delete`,
      canDelete: user.id !== currentUserId && (!hasAdminRole(user.role) || (adminCount?.n ?? 0) > 1),
    })),
    flash: c.req.query('flash') ?? '',
    error: c.req.query('error') ?? '',
  });
});

usersRoutes.get('/users/:id/edit', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .bind(id)
    .first<User>();
  if (!user) return c.notFound();
  return userForm(c, user);
});

usersRoutes.post('/users/:id', requirePermission('users:manage'), async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const user = await c.env.DB.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
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

async function userForm(c: AppContext, user: User, error?: string): Promise<Response> {
  const options = await allRoleOptions(c.env);
  const held = new Set(user.role.split(',').map((role) => role.trim()).filter(Boolean));
  return renderPage(c, userFormPage, {
    id: user.id,
    name: user.name,
    email: user.email,
    error,
    roleOptions: options.map((option) => ({ value: option.name, label: option.label, checked: held.has(option.name) })),
  });
}
