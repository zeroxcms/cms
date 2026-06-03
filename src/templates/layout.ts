import layoutTemplate from '../views/layout/default.liquid';
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

export function layout(opts: LayoutOptions): string {
  const { admin = false, userName = '', userRole = '', userAvatar = '' } = opts;
  const userRoleLabel = userRole.split(',').map((role) => role.trim()).filter(Boolean).join(', ');

  return renderLiquid(layoutTemplate, {
    ...opts,
    admin,
    userName,
    userRole,
    userAvatar,
    userRoleLabel,
    userInitial: userName.charAt(0).toUpperCase(),
    contentClass: admin ? 'ml-64' : '',
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
