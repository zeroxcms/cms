import { renderLiquid } from './liquid';

/** Nav-gating flags forwarded into the sidebar; default false (hidden). */
export interface NavFlags {
  canManageUsers?: boolean;
  canManageRoles?: boolean;
}

/** Extracts the nav-gating flags from a page's props for forwarding to layout().
 *  Accepts any props object (the flags come from buildBaseProps at runtime). */
export function navFlags(opts: unknown): NavFlags {
  const o = (opts ?? {}) as NavFlags;
  return { canManageUsers: o.canManageUsers, canManageRoles: o.canManageRoles };
}

/**
 * Template props shared by every authenticated admin page (built by
 * buildBaseProps). Page opts extend this and add page-specific fields.
 */
export interface BaseTemplateProps extends NavFlags {
  siteTitle: string;
  userName: string;
  userRole: string;
  userAvatar: string;
  currentUserId: string;
  /** Navigation entries contributed by active plugins, filtered to the user's roles. */
  pluginNav: Array<{ label: string; href: string }>;
  canManageUsers: boolean;
  canManageRoles: boolean;
}

/**
 * Wraps a rendered page body in the standard admin layout, forwarding the
 * shared base props (site title, user identity, nav flags). Page functions
 * pass their full opts object as `base` and supply the page title + body.
 */
export async function adminLayout(
  views: Fetcher,
  base: BaseTemplateProps,
  opts: { title: string; body: string },
): Promise<string> {
  return layout(views, {
    ...navFlags(base),
    title: opts.title,
    siteTitle: base.siteTitle,
    body: opts.body,
    admin: true,
    userName: base.userName,
    userRole: base.userRole,
    userAvatar: base.userAvatar,
  });
}

export interface LayoutOptions extends NavFlags {
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
    canManageUsers: opts.canManageUsers ?? false,
    canManageRoles: opts.canManageRoles ?? false,
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
