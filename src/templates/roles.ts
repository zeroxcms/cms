import { layout, navFlags } from './layout';
import { renderView } from './liquid';

export interface RoleListItem {
  name: string;
  label: string;
  badge: string;
  permissionCount: number;
  editHref: string;
  deleteAction: string;
  canDelete: boolean;
}

export async function rolesPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  roles: RoleListItem[];
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, roles } = opts;
  const body = await renderView(views, '/templates/roles.json', {
    hasRoles: roles.length > 0,
    roles,
  });
  return layout(views, {
    ...navFlags(opts), title: 'Roles', siteTitle, body, admin: true, userName, userRole, userAvatar });
}

export async function roleFormPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  isNew: boolean;
  name: string;
  label: string;
  /** built-in roles can't be renamed/deleted; admin is fully locked. */
  builtin: boolean;
  locked: boolean;
  error?: string;
  permissionOptions: Array<{ value: string; label: string; checked: boolean }>;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, isNew, name, label, builtin, locked, error, permissionOptions } = opts;
  const heading = isNew ? 'New Role' : locked ? `View Role: ${label}` : `Edit Role: ${label}`;
  const body = await renderView(views, '/templates/role-form.json', {
    isNew,
    builtin,
    locked,
    heading,
    action: isNew ? '/admin/roles' : `/admin/roles/${name}`,
    deleteAction: `/admin/roles/${name}/delete`,
    canDelete: !isNew && !builtin,
    name,
    label,
    error: error ?? '',
    hasError: !!error,
    permissionOptions,
  });
  return layout(views, {
    ...navFlags(opts), title: heading, siteTitle, body, admin: true, userName, userRole, userAvatar });
}
