import { USER_ROLES, type Permission, type UserRole } from '../types';

const VALID_ROLES = new Set<string>(USER_ROLES);

// Least-privilege capability matrix. A user's effective permissions are the
// union over all roles they hold (roles are a comma-separated list).
//   admin     – full control, including destructive/global ops
//   editor    – full content lifecycle, taxonomy, media, import (no purge/plugins)
//   moderator – review/moderation only: publish, soft-delete, restore
//   viewer    – no admin capabilities (also blocked from /admin by editorGuard)
const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [
    'content:write', 'content:publish', 'content:delete', 'content:import',
    'trash:restore', 'trash:purge', 'taxonomy:write', 'media:upload', 'plugin:access',
    'pagetype:write', 'blocktype:write',
  ],
  editor: [
    'content:write', 'content:publish', 'content:delete', 'content:import',
    'trash:restore', 'taxonomy:write', 'media:upload',
  ],
  moderator: [
    'content:publish', 'content:delete', 'trash:restore',
  ],
  viewer: [],
};

export function parseRoles(value: string): UserRole[] {
  const roles = value
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter((role): role is UserRole => VALID_ROLES.has(role));

  return [...new Set(roles)];
}

export function normalizeRoles(roles: string[]): string {
  const normalized = parseRoles(roles.join(','));
  return normalized.length > 0 ? normalized.join(',') : 'viewer';
}

export function hasAnyRole(value: string, allowedRoles: readonly UserRole[]): boolean {
  const roles = parseRoles(value);
  return allowedRoles.some((role) => roles.includes(role));
}

/** The union of capabilities granted by every role the user holds. */
export function permissionsFor(value: string): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of parseRoles(value)) {
    for (const permission of ROLE_PERMISSIONS[role]) permissions.add(permission);
  }
  return permissions;
}

export function hasPermission(value: string, permission: Permission): boolean {
  return permissionsFor(value).has(permission);
}
