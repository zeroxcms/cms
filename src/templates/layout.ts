// ============================================================
// Shared HTML layout with TailwindCSS Play CDN + VanillaJS
// ============================================================

export interface LayoutOptions {
  title: string;
  siteTitle: string;
  body: string;
  /** Include the admin sidebar? */
  admin?: boolean;
  userName?: string;
  userRole?: string;
  userAvatar?: string;
}

export function layout(opts: LayoutOptions): string {
  const { title, siteTitle, body, admin = false, userName = '', userRole = '', userAvatar = '' } = opts;

  const sidebar = admin
    ? `
    <aside class="fixed inset-y-0 left-0 w-64 bg-gray-900 text-white flex flex-col shadow-xl z-40">
      <div class="flex items-center gap-3 px-6 py-5 border-b border-gray-700">
        <svg class="w-7 h-7 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        <span class="font-bold text-lg tracking-tight">${escHtml(siteTitle)}</span>
      </div>
      <nav class="flex-1 px-4 py-6 space-y-1">
        <a href="/admin"
           class="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M3 7h18M3 12h18M3 17h18"/>
          </svg>
          Pages
        </a>
        <a href="/admin/tags"
           class="flex items-center gap-3 px-3 py-2 rounded-lg text-gray-300 hover:bg-gray-700 hover:text-white transition-colors">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a2 2 0 012-2z"/>
          </svg>
          Tags
        </a>
      </nav>
      <div class="px-4 py-4 border-t border-gray-700">
        <div class="flex items-center gap-3 mb-3">
          ${userAvatar
            ? `<img src="${escHtml(userAvatar)}" class="w-8 h-8 rounded-full" alt="avatar">`
            : `<div class="w-8 h-8 rounded-full bg-indigo-500 flex items-center justify-center text-sm font-bold">${escHtml(userName.charAt(0).toUpperCase())}</div>`
          }
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-white truncate">${escHtml(userName)}</p>
            <p class="text-xs text-gray-400 capitalize">${escHtml(userRole)}</p>
          </div>
        </div>
        <a href="/auth/logout"
           class="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
          Sign out
        </a>
      </div>
    </aside>
    `
    : '';

  const contentClass = admin ? 'ml-64' : '';

  return `<!DOCTYPE html>
<html lang="en" class="h-full bg-gray-50">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} – ${escHtml(siteTitle)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    // Tailwind config
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            brand: {
              50: '#eef2ff',
              600: '#4f46e5',
              700: '#4338ca',
            }
          }
        }
      }
    };

    // Silent token refresh every 14 minutes
    (function() {
      const INTERVAL = 14 * 60 * 1000;
      async function refresh() {
        try {
          const res = await fetch('/auth/refresh', { method: 'POST' });
          if (!res.ok) { window.location.href = '/auth/login'; }
        } catch(e) { /* ignore */ }
      }
      setInterval(refresh, INTERVAL);
    })();
  </script>
</head>
<body class="h-full">
  ${sidebar}
  <div class="${contentClass} min-h-full">
    ${body}
  </div>
</body>
</html>`;
}

/** Minimal HTML escaping to prevent XSS in template strings. */
export function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
