import { layout } from './layout';
import { renderView } from './liquid';

export async function usersPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  users: Array<{ id: number; name: string; email: string; rolesLabel: string; editHref: string }>;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, users } = opts;
  const body = await renderView(views, '/templates/users.json', {
    hasUsers: users.length > 0,
    users,
  });
  return layout(views, { title: 'Users', siteTitle, body, admin: true, userName, userRole, userAvatar });
}

export async function userFormPage(views: Fetcher, opts: {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  id: number;
  name: string;
  email: string;
  error?: string;
  roleOptions: Array<{ value: string; label: string; checked: boolean }>;
}): Promise<string> {
  const { siteTitle, userName, userRole, userAvatar, id, name, email, error, roleOptions } = opts;
  const body = await renderView(views, '/templates/user-form.json', {
    action: `/admin/users/${id}`,
    name,
    email,
    error: error ?? '',
    hasError: !!error,
    roleOptions,
  });
  return layout(views, { title: `Edit ${name || email}`, siteTitle, body, admin: true, userName, userRole, userAvatar });
}
