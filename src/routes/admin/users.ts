// User administration — list users and assign their roles. Admin-gated
// (users:manage). Users are created by OAuth login, not here.

import { Hono } from 'hono';
import { usersPage, userFormPage } from '../../templates/users';
import type { Env, Variables, User } from '../../types';
import { userIdFromContext } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { fetchUserAvatar } from '../../utils/admin-queries';
import { buildBaseProps } from '../../utils/admin-render';
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

usersRoutes.get('/users', async (c) => {
  const [users, userAvatar, options] = await Promise.all([
    c.env.DB.prepare('SELECT id, name, email, role FROM users ORDER BY name ASC, email ASC').all<User>(),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
    allRoleOptions(c.env),
  ]);
  return c.html(await usersPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    users: users.results.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      rolesLabel: rolesLabel(user.role, options),
      editHref: `/admin/users/${user.id}/edit`,
    })),
  }));
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

async function userForm(c: AppContext, user: User, error?: string): Promise<Response> {
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  const options = await allRoleOptions(c.env);
  const held = new Set(user.role.split(',').map((role) => role.trim()).filter(Boolean));
  return c.html(await userFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    id: user.id,
    name: user.name,
    email: user.email,
    error,
    roleOptions: options.map((option) => ({ value: option.name, label: option.label, checked: held.has(option.name) })),
  }));
}
