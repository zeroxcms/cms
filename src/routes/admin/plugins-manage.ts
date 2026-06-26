// ============================================================
// Plugin management — register / enable / disable / configure plugins,
// stored in the `plugins` D1 table (URL transport). Gated by plugin:manage.
//
// Distinct from src/routes/admin/plugins.ts, which proxies *into* a plugin's
// admin UI (plugin:access). This router manages the registry rows themselves.
// ============================================================

import { Hono } from 'hono';
import type { Env, Variables } from '../../types';
import { requirePermission } from '../../middleware/auth';
import { renderPage } from '../../utils/admin-render';
import { logAudit } from '../../utils/audit';
import { str, num } from '../../utils/forms';
import { getPlugins, clearManifestCache } from '../../plugins/registry';
import { clearConfigCache } from '../../plugins/config';
import {
  listPlugins,
  getPlugin,
  getPluginByUrl,
  createPlugin,
  updatePlugin,
  deletePlugin,
  setPluginEnabled,
  setPluginSecret,
  generatePluginSecret,
  type PluginInput,
} from '../../utils/plugin-store';
import { pluginsManagePage, pluginFormPage, type PluginListItem } from '../../templates/plugins-manage';

export const pluginsManageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pluginsManageRoutes.use('/plugins-manage', requirePermission('plugin:manage'));
pluginsManageRoutes.use('/plugins-manage/*', requirePermission('plugin:manage'));

/** Normalizes + validates a plugin base URL. Returns [normalized, error]. */
function normalizeUrl(raw: string): [string, string | null] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [trimmed, 'Enter a valid URL.'];
  }
  if (parsed.protocol === 'https:') return [trimmed, null];
  if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
    return [trimmed, null];
  }
  return [trimmed, 'URL must be HTTPS (http is allowed only for localhost).'];
}

/** Validates optional config JSON. Returns [stored, error]. */
function normalizeConfig(raw: string): [string | null, string | null] {
  const trimmed = raw.trim();
  if (!trimmed) return [null, null];
  try {
    JSON.parse(trimmed);
    return [trimmed, null];
  } catch {
    return [trimmed, 'Config must be valid JSON (or left blank).'];
  }
}

function readForm(form: FormData): { input: PluginInput | null; error: string | null; raw: { label: string; url: string; enabled: boolean; sortOrder: number; config: string } } {
  const label = str(form.get('label'));
  const [url, urlError] = normalizeUrl(str(form.get('url')));
  const enabled = form.get('enabled') != null;
  const sortOrder = num(form.get('sort_order'), 0);
  const [config, configError] = normalizeConfig(str(form.get('config')));
  const raw = { label, url, enabled, sortOrder, config: str(form.get('config')) };

  const error = urlError ?? configError;
  if (error) return { input: null, error, raw };
  return { input: { label, url, enabled, config, sort_order: sortOrder }, error: null, raw };
}

// ── List ──────────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage', async (c) => {
  const [rows, resolved] = await Promise.all([listPlugins(c.env.DB), getPlugins(c.env)]);
  // resolved plugins are keyed by their base URL (ResolvedPlugin.binding).
  const byUrl = new Map(resolved.map((p) => [p.binding, p.manifest]));

  const plugins: PluginListItem[] = rows.map((row) => {
    const manifest = byUrl.get(row.url);
    const status: PluginListItem['status'] = !row.enabled
      ? 'disabled'
      : manifest
        ? 'active'
        : 'unreachable';
    return {
      id: row.id,
      label: row.label,
      url: row.url,
      enabled: !!row.enabled,
      status,
      manifestId: manifest?.id,
      manifestName: manifest?.name,
      version: manifest?.version,
    };
  });

  return renderPage(c, pluginsManagePage, { plugins });
});

// ── Create ──────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/new', async (c) => {
  return renderPage(c, pluginFormPage, {
    isNew: true,
    label: '',
    url: '',
    enabled: true,
    sortOrder: 0,
    config: '',
  });
});

pluginsManageRoutes.post('/plugins-manage', async (c) => {
  const { input, error, raw } = readForm(await c.req.formData());
  if (!input) {
    return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: error ?? undefined });
  }
  // Auto-generate a dedicated secret for the new plugin; the edit page (where we
  // land next) shows it so the admin can copy it onto the plugin Worker.
  const dbError = await createPlugin(c.env.DB, { ...input, secret: generatePluginSecret() });
  if (dbError) {
    return renderPage(c, pluginFormPage, { isNew: true, ...raw, error: dbError });
  }
  invalidate();
  logAudit(c, 'plugin.create', 'plugin', input.url, { label: input.label, enabled: input.enabled });
  const created = await getPluginByUrl(c.env.DB, input.url);
  return c.redirect(created ? `/admin/plugins-manage/${created.id}/edit?flash=secret-generated` : '/admin/plugins-manage');
});

// ── Edit ────────────────────────────────────────────────────────────────────

pluginsManageRoutes.get('/plugins-manage/:id/edit', async (c) => {
  const plugin = await getPlugin(c.env.DB, Number(c.req.param('id')));
  if (!plugin) return c.notFound();
  return renderPage(c, pluginFormPage, {
    isNew: false,
    id: plugin.id,
    label: plugin.label,
    url: plugin.url,
    enabled: !!plugin.enabled,
    sortOrder: plugin.sort_order,
    config: plugin.config ?? '',
    secret: plugin.secret ?? '',
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/rotate-secret', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();
  await setPluginSecret(c.env.DB, id, generatePluginSecret());
  invalidate();
  logAudit(c, 'plugin.rotate_secret', 'plugin', plugin.url);
  return c.redirect(`/admin/plugins-manage/${id}/edit?flash=secret-rotated`);
});

pluginsManageRoutes.post('/plugins-manage/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();

  const { input, error, raw } = readForm(await c.req.formData());
  if (!input) {
    return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: error ?? undefined });
  }
  const dbError = await updatePlugin(c.env.DB, id, input);
  if (dbError) {
    return renderPage(c, pluginFormPage, { isNew: false, id, ...raw, error: dbError });
  }
  invalidate();
  logAudit(c, 'plugin.update', 'plugin', input.url, { label: input.label, enabled: input.enabled });
  return c.redirect('/admin/plugins-manage');
});

pluginsManageRoutes.post('/plugins-manage/:id/toggle', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();
  await setPluginEnabled(c.env.DB, id, !plugin.enabled);
  invalidate();
  logAudit(c, 'plugin.toggle', 'plugin', plugin.url, { enabled: !plugin.enabled });
  return c.redirect('/admin/plugins-manage');
});

pluginsManageRoutes.post('/plugins-manage/:id/delete', async (c) => {
  const id = Number(c.req.param('id'));
  const plugin = await getPlugin(c.env.DB, id);
  if (!plugin) return c.notFound();
  await deletePlugin(c.env.DB, id);
  invalidate();
  logAudit(c, 'plugin.delete', 'plugin', plugin.url);
  return c.redirect('/admin/plugins-manage');
});

/** After any registry mutation, drop the plugin-list, manifest, and merged-config caches. */
function invalidate(): void {
  clearManifestCache();
  clearConfigCache();
}
