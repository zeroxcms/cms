import { renderLiquid } from './liquid';

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

export async function layout(views: Fetcher, opts: LayoutOptions): Promise<string> {
  const { admin = false, userName = '', userRole = '', userAvatar = '' } = opts;
  const normalizedUserAvatar = userAvatar.trim();
  const hasUserAvatar = normalizedUserAvatar.length > 0;
  const userRoleLabel = userRole.split(',').map((role) => role.trim()).filter(Boolean).join(', ');

  return renderLiquid(views, '/layout/default.liquid', {
    ...opts,
    admin,
    userName,
    userRole,
    userAvatar: normalizedUserAvatar,
    hasUserAvatar,
    userRoleLabel,
    userInitial: userName.trim().charAt(0).toUpperCase() || '?',
    contentClass: admin ? 'md:ml-64' : '',
  });
}

/** Minimal HTML escaping to prevent XSS in pre-rendered HTML fragments. */
export function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
