// ============================================================
// Plugin-rendered page edit/create view.
//
// When a plugin declares a page type in its manifest `editViews` or `newViews`,
// the CMS hands the matching edit/create view for that type to the plugin
// instead of rendering the built-in editor. The CMS POSTs the editor context to
// the plugin's `/__plugin/edit` endpoint, wraps the returned HTML *fragment* in
// the standard admin chrome (same sidebar/fonts/CSS as every CMS page), and
// serves it under the CMS origin — exactly like the chrome path in
// routes/admin/plugins.ts.
//
// The plugin's form posts back to the CMS's existing create/update handler
// (the `action` in the context), so save / version / publish logic is
// unchanged. A 404 — or any error/non-HTML response — from the plugin makes
// the CMS fall back to its built-in editor, so a half-implemented plugin can
// never lock an editor out of a page.
//
// Like the proxied plugin admin pages, the wrapped fragment runs under the
// CMS's strict nonce CSP, so plugin edit views should contribute any field
// markup through Liquid snippets / view files rather than inline scripts.
// ============================================================

import type { AppContext } from '../utils/context';
import type { ResolvedPlugin } from '../types';
import { pluginForEditView, pluginForNewView, pluginForReadView, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { adminLayout, escHtml, type ApprovedPluginAssets } from '../templates/layout';
import { pluginClientView } from '../templates/liquid';
import { buildBaseProps } from '../utils/admin-render';
import { viewsFor } from './views';
import { sanitizePluginHtmlFragment } from '../security/plugin-sanitize';
import { isPluginClientViewResponse, pluginTenantId, readPluginClientViewData, setPluginAuthHeaders } from '../security/plugin-proxy';
import { listApprovals } from '../utils/plugin-assets';
import { pluginViewRevision, pluginWorkerRevision } from '../utils/view-revision';
import { resolveUiLocale } from '../utils/i18n';

/** Editor context the CMS sends to a plugin's `/__plugin/edit` endpoint. */
export interface EditViewContext {
  /** 'new' for the create form, 'edit' for an existing page. */
  mode: 'new' | 'edit';
  /** Form POST target — the CMS's existing create/update handler. */
  action: string;
  /** Where the editor's back / cancel control should return to. */
  backHref: string;
  /** Active editing language. */
  language: string;
  /** Signed-in user's CMS interface locale (added by the dispatcher). */
  uiLocale?: string;
  /** Text direction for uiLocale. */
  uiDirection?: 'ltr' | 'rtl';
  /** The page type being edited/created (one of the plugin's declared editViews or newViews). */
  pageType: string;
  page: {
    /** Numeric id when editing; '' when creating. */
    id: number | string;
    name: string;
    slug: string;
    pageType: string;
    weight: number;
    start: string | null;
    end: string | null;
    timezone: string | null;
    editors: string | null;
    /** Stringified lect JSON for the current/selected version. */
    lect: string;
  };
  /** Saved versions (most-recent first), for an optional version picker. */
  versions: Array<{ id: number; created_at: string; action: string | null }>;
  /** Flash message to surface, if any. */
  flash?: string;
  /** Validation errors to surface when re-rendering after a failed save. */
  errors?: string[];
}

/** Read-only context the CMS sends to a plugin's `/__plugin/read` endpoint.
 *  Mirrors EditViewContext minus the form-submission fields — a read view has
 *  nothing to POST back — plus `editHref` so it can offer an "Edit" control. */
export interface ReadViewContext {
  /** Link to the CMS editor for this page (for an optional "Edit" control). */
  editHref: string;
  /** Where the view's back / cancel control should return to. */
  backHref: string;
  /** Active display language. */
  language: string;
  /** Signed-in user's CMS interface locale (added by the dispatcher). */
  uiLocale?: string;
  /** Text direction for uiLocale. */
  uiDirection?: 'ltr' | 'rtl';
  /** The page type being viewed (one of the plugin's declared readViews). */
  pageType: string;
  page: EditViewContext['page'];
  /** Saved versions (most-recent first), for an optional version picker. */
  versions: EditViewContext['versions'];
}

/**
 * Renders the edit/new view through the plugin that owns `pageType`, returning
 * a ready-to-send chrome-wrapped Response — or `null` when no plugin owns the
 * type, the plugin is misconfigured, or it declined (404 / error / non-HTML),
 * in which case the caller renders the built-in editor.
 */
export async function pluginEditView(
  c: AppContext,
  pageType: string,
  context: EditViewContext,
): Promise<Response | null> {
  const plugin = await pluginForEditView(c.env, pageType);
  if (!plugin) return null;
  const fallbackTitle = context.mode === 'edit' ? `Edit: ${context.page.name}` : `New ${pageType}`;
  return dispatchPluginView(c, plugin, '/edit', context, fallbackTitle, 'edit view');
}

/**
 * Renders the create/new view through the plugin that owns `pageType`. Explicit
 * manifest `newViews` entries win; legacy `editViews` entries still own the new
 * form for backwards compatibility.
 */
export async function pluginNewView(
  c: AppContext,
  pageType: string,
  context: EditViewContext,
): Promise<Response | null> {
  const plugin = await pluginForNewView(c.env, pageType);
  if (!plugin) return null;
  return dispatchPluginView(c, plugin, '/edit', context, `New ${pageType}`, 'new view');
}

/**
 * Renders the read-only view through the plugin that owns `pageType` (its
 * manifest `readViews`), returning a chrome-wrapped Response — or `null` when no
 * plugin owns the type, the plugin is misconfigured, or it declined (404 /
 * error / non-HTML), in which case the caller renders the built-in read view.
 */
export async function pluginReadView(
  c: AppContext,
  pageType: string,
  context: ReadViewContext,
): Promise<Response | null> {
  const plugin = await pluginForReadView(c.env, pageType);
  if (!plugin) return null;
  return dispatchPluginView(c, plugin, '/read', context, `View: ${context.page.name}`, 'read view');
}

/**
 * Shared plumbing for both plugin-rendered views: forwards the signed-in user +
 * plugin secret, POSTs the context to the plugin's `/__plugin/<endpoint>`,
 * validates the response, and wraps the returned fragment (or client view) in
 * the standard admin chrome. Returns `null` on any decline/failure so the
 * caller can fall back to the built-in view.
 */
async function dispatchPluginView(
  c: AppContext,
  plugin: ResolvedPlugin,
  endpoint: '/edit' | '/read',
  context: EditViewContext | ReadViewContext,
  fallbackTitle: string,
  label: string,
): Promise<Response | null> {
  // A plugin that can't authenticate must not silently take over the view;
  // fall back to the built-in one (and log) rather than fail the request.
  if (!plugin.secret) {
    console.error(`Plugin ${plugin.manifest.id} declares a ${label} but has no secret configured`);
    return null;
  }

  const user = c.get('user');
  const uiLocale = await resolveUiLocale(c);
  const localizedContext = { ...context, uiLocale: uiLocale.code, uiDirection: uiLocale.direction };
  const headers = new Headers({
    'content-type': 'application/json',
    'x-cms-user': JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  });
  setPluginAuthHeaders(headers, plugin.secret, pluginTenantId(c.env));

  let upstream: Response;
  try {
    upstream = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(localizedContext),
    });
  } catch (error) {
    console.error(`Plugin ${plugin.manifest.id} ${label} fetch failed:`, error);
    return null;
  }

  if (!upstream.ok) {
    // 404 = "I don't actually render this view"; anything else is unexpected.
    if (upstream.status !== 404) {
      console.error(`Plugin ${plugin.manifest.id} ${label} returned ${upstream.status}`);
    }
    return null;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const clientView = await readPluginClientViewData(upstream.clone());
  if (!contentType.includes('text/html') && !clientView) {
    console.error(`Plugin ${plugin.manifest.id} ${label} returned non-HTML (${contentType})`);
    return null;
  }

  if (upstream.headers.get('x-cms-client-view') === '1' && !isPluginClientViewResponse(upstream)) {
    console.error(`Plugin ${plugin.manifest.id} ${label} returned an invalid client view`);
    return null;
  }

  const title = decodeTitle(upstream.headers.get('x-cms-title')) || fallbackTitle;
  const base = await buildBaseProps(c);
  const editPresence = pluginEditPresence(endpoint, context, base);
  const body = clientView
    ? pluginClientView(
        clientView.viewPath,
        editPresence ? { ...clientView.data, cmsEditPresence: editPresence } : clientView.data,
        `/admin/plugins/${plugin.manifest.id}/views`,
        pluginViewRevision(plugin.manifest),
      )
    : withPluginEditPresenceBar(await sanitizePluginHtmlFragment(await upstream.text()), editPresence);
  const declaredAssetPaths = new Set((plugin.manifest.assets ?? []).map((asset) => asset.path));
  const approvedPluginAssets = await approvedAssetsFor(c, plugin.manifest, declaredAssetPaths);
  const wrapped = await adminLayout(viewsFor(c.env), base, { title, body, editorSync: !!editPresence, approvedPluginAssets });
  // No explicit CSP: the global security middleware applies the strict nonce
  // policy (matching the nonce adminLayout embeds), like any CMS page.
  return c.html(wrapped);
}

/** Admin-approved assets for a plugin, restricted to paths it currently
 *  declares in its manifest. Mirrors the plugin admin chrome path so plugin
 *  page-view overrides can load the same approved JS/CSS assets. */
async function approvedAssetsFor(
  c: AppContext,
  manifest: ResolvedPlugin['manifest'],
  declaredPaths: Set<string>,
): Promise<ApprovedPluginAssets> {
  if (declaredPaths.size === 0) return {};
  const pluginRevision = pluginWorkerRevision(manifest);
  const approvals = await listApprovals(c.env.DB, manifest.id);
  const entries = approvals
    .filter((approval) => declaredPaths.has(approval.path))
    .map((approval) => ({
      path: approval.path,
      integrity: approval.integrity,
      revision: pluginRevision || approval.integrity,
    }));
  return entries.length ? { [manifest.id]: entries } : {};
}

interface PluginEditPresence {
  pageId: string;
  currentUserId: string;
  userAvatar: string;
}

function pluginEditPresence(
  endpoint: '/edit' | '/read',
  context: EditViewContext | ReadViewContext,
  base: Awaited<ReturnType<typeof buildBaseProps>>,
): PluginEditPresence | null {
  if (endpoint !== '/edit') return null;
  const editContext = context as EditViewContext;
  if (editContext.mode !== 'edit') return null;
  const pageId = String(editContext.page.id ?? '').trim();
  if (!pageId) return null;
  return {
    pageId,
    currentUserId: base.currentUserId,
    userAvatar: base.userAvatar,
  };
}

function withPluginEditPresenceBar(body: string, presence: PluginEditPresence | null): string {
  if (!presence || body.includes('id="presence-bar"')) return body;
  return `<div class="mb-4 flex justify-end" data-plugin-editor-presence>
    <div id="presence-bar"
         class="flex items-center gap-1.5 shrink-0"
         data-page-id="${escHtml(presence.pageId)}"
         data-user-id="${escHtml(presence.currentUserId)}"
         data-user-avatar="${escHtml(presence.userAvatar)}">
      <div id="presence-avatars" class="flex items-center gap-1"></div>
      <div id="sync-indicator"
           title=""
           style="width:8px;height:8px;border-radius:50%;background:#9ca3af;flex-shrink:0;transition:background .4s,opacity .4s;display:none"></div>
    </div>
  </div>${body}`;
}

/** Decodes the percent-encoded x-cms-title header (plugins encode it for header safety). */
function decodeTitle(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
