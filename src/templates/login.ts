import { layout } from './layout';
import { renderView } from './liquid';

function providerLabel(provider: string): string {
  if (provider === 'google') return 'Google';
  if (provider === 'microsoft') return 'Microsoft';
  if (provider === 'apple') return 'Apple';
  if (provider === 'eventuai') return 'Eventuai';
  return 'GitHub';
}

function providerIcon(provider: string): string {
  if (provider === 'google') {
    return `<svg class="w-5 h-5" viewBox="0 0 24 24"><use href="/assets/icons.svg#google"></use></svg>`;
  }
  if (provider === 'microsoft') {
    return `<svg class="w-5 h-5" viewBox="0 0 24 24"><use href="/assets/icons.svg#microsoft"></use></svg>`;
  }
  if (provider === 'apple') {
    return `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><use href="/assets/icons.svg#apple"></use></svg>`;
  }
  if (provider === 'eventuai') {
    return `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><use href="/assets/icons.svg#key"></use></svg>`;
  }
  return `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><use href="/assets/icons.svg#github"></use></svg>`;
}

export async function loginPage(views: Fetcher, opts: {
  siteTitle: string;
  providers: string[];
  error?: string;
  viewRevision?: string;
}): Promise<string> {
  const { siteTitle, providers, error } = opts;

  const body = await renderView(views, '/templates/login.json', {
    siteTitle,
    error,
    isForbidden: error === 'forbidden',
    providers: providers.map((provider) => {
      const isPrimary = provider === 'eventuai';
      return {
        name: provider,
        href: `/auth/start?provider=${encodeURIComponent(provider)}`,
        label: providerLabel(provider),
        icon: providerIcon(provider),
        buttonClass: isPrimary
          ? 'border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700'
          : 'border-gray-200 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50',
        iconClass: isPrimary ? 'text-white' : 'text-gray-600 group-hover:text-indigo-600',
      };
    }),
  });

  return layout(views, { title: 'Sign In', siteTitle, body, viewRevision: opts.viewRevision });
}
