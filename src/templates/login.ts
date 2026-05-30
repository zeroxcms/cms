// ============================================================
// Login page template
// ============================================================

import { layout, escHtml } from './layout';

export function loginPage(opts: {
  siteTitle: string;
  provider: string;
  error?: string;
}): string {
  const { siteTitle, provider, error } = opts;

  const providerLabel =
    provider === 'google' ? 'Google' :
    provider === 'eventuai' ? 'Eventuai' :
    'GitHub';
  const providerIcon =
    provider === 'google'
      ? `<svg class="w-5 h-5" viewBox="0 0 24 24">
           <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
           <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
           <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
           <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
         </svg>`
      : provider === 'eventuai'
      ? `<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
           <path stroke-linecap="round" stroke-linejoin="round"
             d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z"/>
         </svg>`
      : `<svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
           <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
         </svg>`;

  const errorBanner = error
    ? `<div class="mb-4 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">
        ${error === 'forbidden'
          ? 'You do not have permission to access the admin panel.'
          : `Authentication error: ${escHtml(error)}`}
       </div>`
    : '';

  const body = `
    <div class="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-50 to-blue-100 px-4">
      <div class="w-full max-w-md">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600 shadow-lg mb-4">
            <svg class="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
            </svg>
          </div>
          <h1 class="text-3xl font-bold text-gray-900">${escHtml(siteTitle)}</h1>
          <p class="mt-2 text-gray-500">Sign in to manage your content</p>
        </div>

        <div class="bg-white rounded-2xl shadow-xl p-8">
          ${errorBanner}
          <a href="/auth/start"
             class="flex items-center justify-center gap-3 w-full px-4 py-3 rounded-xl border-2 ${provider === 'eventuai' ? 'border-indigo-500 bg-indigo-600 text-white hover:bg-indigo-700' : 'border-gray-200 text-gray-700 hover:border-indigo-400 hover:bg-indigo-50'} font-semibold transition-all duration-150 group">
            <span class="${provider === 'eventuai' ? 'text-white' : 'text-gray-600 group-hover:text-indigo-600'} transition-colors">${providerIcon}</span>
            Continue with ${providerLabel}
          </a>

          <p class="mt-6 text-center text-xs text-gray-400">
            Only users with <strong>admin</strong>, <strong>editor</strong>, or
            <strong>moderator</strong> roles can access the CMS.
          </p>
        </div>
      </div>
    </div>`;

  return layout({ title: 'Sign In', siteTitle, body });
}
