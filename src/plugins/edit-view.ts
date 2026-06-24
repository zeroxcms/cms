// ============================================================
// Plugin-rendered page edit view.
//
// When a plugin declares a page type in its manifest `editViews`, the CMS
// hands the whole edit/new view for that type to the plugin instead of
// rendering the built-in editor. The CMS POSTs the editor context to the
// plugin's `/__plugin/edit` endpoint, wraps the returned HTML *fragment* in
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
import { pluginForEditView, PLUGIN_ORIGIN, PLUGIN_PREFIX } from './registry';
import { adminLayout } from '../templates/layout';
import { buildBaseProps } from '../utils/admin-render';
import { viewsFor } from './views';

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
  /** The page type being edited (one of the plugin's declared editViews). */
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

  // A plugin that can't authenticate must not silently take over the editor;
  // fall back to the built-in view (and log) rather than fail the request.
  if (!plugin.secret) {
    console.error(`Plugin ${plugin.manifest.id} declares an edit view but has no secret configured`);
    return null;
  }

  const user = c.get('user');
  const headers = new Headers({
    'content-type': 'application/json',
    'x-plugin-secret': plugin.secret,
    'x-cms-user': JSON.stringify({ id: user.sub, email: user.email, name: user.name, role: user.role }),
  });

  let upstream: Response;
  try {
    upstream = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify(context),
    });
  } catch (error) {
    console.error(`Plugin ${plugin.manifest.id} edit view fetch failed:`, error);
    return null;
  }

  if (!upstream.ok) {
    // 404 = "I don't actually render this view"; anything else is unexpected.
    if (upstream.status !== 404) {
      console.error(`Plugin ${plugin.manifest.id} edit view returned ${upstream.status}`);
    }
    return null;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    console.error(`Plugin ${plugin.manifest.id} edit view returned non-HTML (${contentType})`);
    return null;
  }

  const fragment = await upstream.text();
  const title = decodeTitle(upstream.headers.get('x-cms-title'))
    || (context.mode === 'edit' ? `Edit: ${context.page.name}` : `New ${pageType}`);
  const base = await buildBaseProps(c);
  const wrapped = await adminLayout(viewsFor(c.env), base, { title, body: fragment });
  // No explicit CSP: the global security middleware applies the strict nonce
  // policy (matching the nonce adminLayout embeds), like any CMS page.
  return c.html(wrapped);
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
