import { adminLayout, type BaseTemplateProps } from './layout';
import { renderView } from './liquid';
import type { UserCreditLedgerRow } from './users';

export interface ProfileIdentity {
  id: string;
  provider: string;
  label: string;
  providerUserId: string;
  disconnectHref: string;
  canDisconnect: boolean;
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
  flash?: string;
  error?: string;
  identities: ProfileIdentity[];
  providers: ProfileProvider[];
  creditBalance: number;
  creditLedger: UserCreditLedgerRow[];
}): Promise<string> {
  const body = await renderView(views, '/templates/profile.json', {
    name: opts.name,
    email: opts.email,
    roleLabel: opts.roleLabel,
    avatarUrl: opts.avatarUrl,
    flash: opts.flash ?? '',
    error: opts.error ?? '',
    hasFlash: !!opts.flash,
    hasError: !!opts.error,
    hasAvatar: opts.avatarUrl.length > 0,
    initial: opts.name.trim().charAt(0).toUpperCase() || opts.email.trim().charAt(0).toUpperCase() || '?',
    hasIdentities: opts.identities.length > 0,
    identities: opts.identities,
    hasProviders: opts.providers.length > 0,
    providers: opts.providers,
    creditBalance: opts.creditBalance,
    hasCreditLedger: opts.creditLedger.length > 0,
    creditLedger: opts.creditLedger,
  });
  return adminLayout(views, opts, { title: 'Profile', body });
}
