import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';

export interface ProfileIdentity {
  provider: string;
  label: string;
  providerUserId: string;
  connected: boolean;
}

export interface ProfileProvider {
  provider: string;
  label: string;
  connected: boolean;
  connectHref: string;
}

export async function profilePage(views: Fetcher, opts: BaseTemplateProps & {
  email: string;
  name: string;
  roleLabel: string;
  avatarUrl: string;
  identities: ProfileIdentity[];
  providers: ProfileProvider[];
}): Promise<string> {
  const body = await renderView(views, '/templates/profile.json', {
    name: opts.name,
    email: opts.email,
    roleLabel: opts.roleLabel,
    avatarUrl: opts.avatarUrl,
    hasAvatar: opts.avatarUrl.length > 0,
    initial: opts.name.trim().charAt(0).toUpperCase() || opts.email.trim().charAt(0).toUpperCase() || '?',
    hasIdentities: opts.identities.length > 0,
    identities: opts.identities,
    hasProviders: opts.providers.length > 0,
    providers: opts.providers,
  });
  return adminLayout(views, opts, { title: 'Profile', body });
}
