import { USER_ROLES, type UserRole } from '../types';

const VALID_ROLES = new Set<string>(USER_ROLES);

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
