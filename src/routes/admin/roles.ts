// Role administration — create/edit/delete roles and assign permissions.
// Admin-gated (roles:manage). The 'admin' role is all-powerful and locked.

import { Hono } from 'hono';
import { roleFormPage, rolesPage } from '../../templates/roles';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS } from '../../types';
import type { Env, Variables, Permission } from '../../types';
import { slugify, str, userIdFromContext } from '../../utils/forms';
import { logAudit } from '../../utils/audit';
import { requirePermission } from '../../middleware/auth';
import { fetchUserAvatar } from '../../utils/admin-queries';
import { buildBaseProps } from '../../utils/admin-render';
import { clearRolePermissionsCache } from '../../utils/roles';
import {
  createCustomRole,
  deleteCustomRole,
  getRoleForEdit,
  listRolesForAdmin,
  saveRolePermissions,
} from '../../utils/role-store';

export const rolesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

rolesRoutes.use('/roles', requirePermission('roles:manage'));
rolesRoutes.use('/roles/*', requirePermission('roles:manage'));

function permissionOptions(granted: Set<Permission>) {
  return PERMISSIONS.map((permission) => ({
    value: permission,
    label: PERMISSION_DESCRIPTIONS[permission],
    checked: granted.has(permission),
  }));
}

rolesRoutes.get('/roles', async (c) => {
  const [roles, userAvatar] = await Promise.all([
    listRolesForAdmin(c.env),
    fetchUserAvatar(c.env.DB, userIdFromContext(c)),
  ]);
  return c.html(await rolesPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    roles: roles.map((role) => ({
      name: role.name,
      label: role.label,
      badge: role.builtin ? (role.locked ? 'admin' : 'built-in') : 'custom',
      permissionCount: role.locked ? PERMISSIONS.length : role.permissionCount,
      editHref: `/admin/roles/${encodeURIComponent(role.name)}/edit`,
      deleteAction: `/admin/roles/${encodeURIComponent(role.name)}/delete`,
      canDelete: !role.builtin,
    })),
  }));
});

// ── Create ──────────────────────────────────────────────────────────────────

rolesRoutes.get('/roles/new', async (c) => {
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  return c.html(await roleFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    isNew: true,
    name: '',
    label: '',
    builtin: false,
    locked: false,
    permissionOptions: [],
  }));
});

rolesRoutes.post('/roles', async (c) => {
  const form = await c.req.formData();
  const label = str(form.get('label'));
  const name = str(form.get('name')) ? slugify(str(form.get('name'))) : slugify(label);

  const error = await createCustomRole(c.env, name, label);
  if (error) {
    const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
    return c.html(await roleFormPage(c.env.VIEWS, {
      ...(await buildBaseProps(c, userAvatar)),
      isNew: true,
      name: str(form.get('name')),
      label,
      builtin: false,
      locked: false,
      error,
      permissionOptions: [],
    }));
  }
  clearRolePermissionsCache();
  logAudit(c, 'role.create', 'role', name, { label });
  return c.redirect(`/admin/roles/${encodeURIComponent(name)}/edit`);
});

// ── Edit ────────────────────────────────────────────────────────────────────

rolesRoutes.get('/roles/:name/edit', async (c) => {
  const role = await getRoleForEdit(c.env, c.req.param('name'));
  if (!role) return c.notFound();
  const userAvatar = await fetchUserAvatar(c.env.DB, userIdFromContext(c));
  return c.html(await roleFormPage(c.env.VIEWS, {
    ...(await buildBaseProps(c, userAvatar)),
    isNew: false,
    name: role.name,
    label: role.label,
    builtin: role.builtin,
    locked: role.locked,
    permissionOptions: permissionOptions(role.locked ? new Set(PERMISSIONS) : role.permissions),
  }));
});

rolesRoutes.post('/roles/:name', async (c) => {
  const name = c.req.param('name');
  const role = await getRoleForEdit(c.env, name);
  if (!role) return c.notFound();
  if (role.locked) return c.text('Forbidden: the admin role cannot be edited', 403);

  const form = await c.req.formData();
  const label = role.builtin ? role.label : (str(form.get('label')) || role.label);
  const permissions = form.getAll('permissions').map(String);

  await saveRolePermissions(c.env, name, label, permissions);
  clearRolePermissionsCache();
  logAudit(c, 'role.update', 'role', name, { permissions: permissions.length });
  return c.redirect('/admin/roles');
});

rolesRoutes.post('/roles/:name/delete', async (c) => {
  const name = c.req.param('name');
  await deleteCustomRole(c.env, name);
  clearRolePermissionsCache();
  logAudit(c, 'role.delete', 'role', name);
  return c.redirect('/admin/roles');
});
