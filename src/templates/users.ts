import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export async function usersPage(views: Fetcher, opts: BaseTemplateProps & {
  users: Array<{ id: number; name: string; email: string; rolesLabel: string; editHref: string }>;
}): Promise<string> {
  const { users } = opts;
  const body = await renderView(views, '/templates/users.json', {
    hasUsers: users.length > 0,
    users,
  });
  return adminLayout(views, opts, { title: 'Users', body });
}

export async function userFormPage(views: Fetcher, opts: BaseTemplateProps & {
  id: number;
  name: string;
  email: string;
  error?: string;
  roleOptions: Array<{ value: string; label: string; checked: boolean }>;
}): Promise<string> {
  const { id, name, email, error, roleOptions } = opts;
  const body = await renderView(views, '/templates/user-form.json', {
    action: `/admin/users/${id}`,
    name,
    email,
    error: error ?? '',
    hasError: !!error,
    roleOptions,
  });
  return adminLayout(views, opts, { title: `Edit ${name || email}`, body });
}
