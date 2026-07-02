import { currentCspNonce } from '../utils/request-context';
import { isClientView, type RenderedView } from './liquid';

/** Nav-gating flags forwarded into the sidebar; default false (hidden). */
export interface NavFlags {
  canManageUsers?: boolean;
  canManageRoles?: boolean;
  canManagePlugins?: boolean;
}

/** Extracts the nav-gating flags from a page's props for forwarding to layout().
 *  Accepts any props object (the flags come from buildBaseProps at runtime). */
export function navFlags(opts: unknown): NavFlags {
  const o = (opts ?? {}) as NavFlags;
  return { canManageUsers: o.canManageUsers, canManageRoles: o.canManageRoles, canManagePlugins: o.canManagePlugins };
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
  /** Plugin nav entries targeting the Settings group (group: 'settings'). */
  pluginSettingsNav: Array<{ label: string; href: string }>;
  /** Cache-busting revision appended to browser-fetched view files. */
  viewRevision: string;
  canManageUsers: boolean;
  canManageRoles: boolean;
  canManagePlugins: boolean;
}

/**
 * Wraps a rendered page body in the standard admin layout, forwarding the
 * shared base props (site title, user identity, nav flags). Page functions
 * pass their full opts object as `base` and supply the page title + body.
 */
export async function adminLayout(
  views: Fetcher,
  base: BaseTemplateProps,
  opts: { title: string; body: RenderedView; approvedPluginAssets?: ApprovedPluginAssets },
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
    pluginNav: base.pluginNav,
    pluginSettingsNav: base.pluginSettingsNav,
    viewRevision: base.viewRevision,
    approvedPluginAssets: opts.approvedPluginAssets,
  });
}

/** Admin-approved plugin assets (see PluginManifest.assets), keyed by plugin id,
 *  forwarded into the client render payload so client-render.js can let a
 *  matching <script src> / <link> survive plugin-HTML sanitization. */
export interface ApprovedPluginAsset {
  path: string;
  integrity: string;
  revision: string;
}
export type ApprovedPluginAssets = Record<string, ApprovedPluginAsset[]>;

export interface LayoutOptions extends NavFlags {
  title: string;
  siteTitle: string;
  body: RenderedView;
  /** Include the admin sidebar? */
  admin?: boolean;
  userName?: string;
  userRole?: string;
  userAvatar?: string;
  /** Nav entries contributed by active plugins (already role-filtered). */
  pluginNav?: Array<{ label: string; href: string }>;
  /** Plugin nav entries for the Settings group (already role-filtered). */
  pluginSettingsNav?: Array<{ label: string; href: string }>;
  /** Cache-busting revision appended to browser-fetched view files. */
  viewRevision?: string;
  /** Admin-approved plugin assets available to the current page's plugin (if any). */
  approvedPluginAssets?: ApprovedPluginAssets;
}

export async function layout(views: Fetcher, opts: LayoutOptions): Promise<string> {
  const { admin = false, userName = '', userRole = '', userAvatar = '' } = opts;
  const normalizedUserAvatar = userAvatar.trim();
  const hasUserAvatar = normalizedUserAvatar.length > 0;
  const userRoleLabel = userRole.split(',').map((role) => role.trim()).filter(Boolean).join(', ');
  const nonce = currentCspNonce();
  const revision = opts.viewRevision || 'dev';
  const revisionQuery = assetRevisionQuery(revision);
  const layoutData = {
    ...opts,
    body: isClientView(opts.body) ? '' : opts.body,
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
    canManagePlugins: opts.canManagePlugins ?? false,
    pluginNav: opts.pluginNav ?? [],
    pluginSettingsNav: opts.pluginSettingsNav ?? [],
    viewRevision: revision,
    assetRevisionQuery: revisionQuery,
    iconHrefPrefix: `/assets/icons.svg${revisionQuery}`,
    nonce,
  };
  const payload = {
    nonce,
    viewRevision: revision,
    viewBasePath: admin ? '/admin/views' : '/views',
    layoutPath: '/layout/default.liquid',
    layoutData,
    bodyView: isClientView(opts.body) ? opts.body : null,
    approvedPluginAssets: opts.approvedPluginAssets ?? {},
  };

  void views;
  return `<!DOCTYPE html>
<html lang="en" class="h-full overflow-x-hidden bg-gray-50">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(opts.title)} - ${escHtml(opts.siteTitle)}</title>
  <link rel="stylesheet" href="/assets/admin.css${escHtml(revisionQuery)}">
</head>
<body class="h-full overflow-x-hidden">
  <div id="cms-client-root" class="min-h-full">${loadingMarkup('100vh')}</div>
  <script id="cms-render-payload" type="application/json" nonce="${escHtml(nonce)}">${jsonScript(payload)}</script>
  ${admin ? `<script nonce="${escHtml(nonce)}">${adminSessionKeepaliveScript()}</script>` : ''}
  <script src="/assets/liquid.browser.min.js${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>
  <script src="/assets/client-render.js${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>
  <script src="/assets/table-filter.js${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>
  <script src="/assets/privacy-table.js${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>
  <script src="/assets/color-tag.js${escHtml(revisionQuery)}" nonce="${escHtml(nonce)}" defer></script>
</body>
</html>`;
}

export function assetRevisionQuery(revision?: string): string {
  const value = revision || 'dev';
  return value ? `?r=${encodeURIComponent(value)}` : '';
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

function jsonScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function loadingMarkup(minHeight: string): string {
  return `<div role="status" aria-label="Loading" style="min-height:${escHtml(minHeight)};display:flex;align-items:center;justify-content:center;color:#6b7280">
    <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" style="display:block">
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="3" opacity="0.2"></circle>
      <path d="M28 16a12 12 0 0 0-12-12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 16 16" to="360 16 16" dur="0.8s" repeatCount="indefinite"></animateTransform>
      </path>
    </svg>
  </div>`;
}

function adminSessionKeepaliveScript(): string {
  return `(function() {
      if (window.__cmsSessionKeepaliveBound) return;
      window.__cmsSessionKeepaliveBound = true;
      var INTERVAL = 10 * 60 * 1000;
      var inFlight = false;

      async function refresh() {
        if (inFlight) return;
        inFlight = true;
        try {
          var res = await fetch('/auth/refresh', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
          });
          if (res.status === 401) window.location.href = '/auth/login';
        } catch (error) {
          /* retry on the next tick */
        } finally {
          inFlight = false;
        }
      }

      window.setInterval(refresh, INTERVAL);
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') refresh();
      });
    })();`;
}
