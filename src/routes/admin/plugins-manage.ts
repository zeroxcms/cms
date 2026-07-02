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
import { approveAsset, computeIntegrity, getAssetApproval, listApprovals, revokeAsset } from '../../utils/plugin-assets';
import { PLUGIN_ORIGIN } from '../../plugins/registry';
import { pluginsManagePage, pluginFormPage, pluginAssetsPage, type PluginListItem } from '../../templates/plugins-manage';

export const pluginsManageRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

pluginsManageRoutes.use('/plugins-manage', requirePermission('plugin:manage'));
pluginsManageRoutes.use('/plugins-manage/*', requirePermission('plugin:manage'));

/**
 * Best-effort SSRF guard: rejects hostnames that are literally a private,
 * loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, or
 * .internal address. The CMS issues server-side requests to plugin URLs and
 * forwards the signed-in user summary + the plugin secret, so a registered URL
 * must not be able to point those at internal infrastructure. This does not
 * defend against DNS rebinding or a public hostname that resolves to a private
 * IP — it only blocks the obvious literals.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true; // IPv6 ULA / link-local
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;        // link-local + cloud metadata
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
}

/** Normalizes + validates a plugin base URL. Returns [normalized, error]. */
function normalizeUrl(raw: string): [string, string | null] {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return [trimmed, 'Enter a valid URL.'];
  }
  // localhost over http stays allowed for local development against a plugin
  // Worker on another port; every other host must be HTTPS and non-private.
  if (parsed.protocol === 'http:' && parsed.hostname === 'localhost') {
    return [trimmed, null];
  }
  if (parsed.protocol !== 'https:') {
    return [trimmed, 'URL must be HTTPS (http is allowed only for localhost).'];
  }
  if (isPrivateHost(parsed.hostname)) {
    return [trimmed, 'URL must not point to a private, loopback, or internal host.'];
  }
  return [trimmed, null];
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
      hasAssets: !!manifest?.assets?.length,
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

// ── Asset approvals ────────────────────────────────────────────────────────
// A plugin's manifest only *declares* candidate JS/CSS files (PluginManifest.
// assets); nothing runs in CMS chrome until an admin explicitly approves a
// path here, pinning its content hash. See utils/plugin-assets.ts.

async function resolvedPluginFor(env: Env, id: number) {
  const row = await getPlugin(env.DB, id);
  if (!row) return null;
  const resolved = (await getPlugins(env)).find((plugin) => plugin.binding === row.url);
  return { row, resolved };
}

pluginsManageRoutes.get('/plugins-manage/:id/assets', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found) return c.notFound();
  const { row, resolved } = found;
  if (!resolved) {
    return renderPage(c, pluginAssetsPage, {
      pluginId: id,
      pluginLabel: row.label || row.url,
      unreachable: true,
      assets: [],
      flash: c.req.query('flash') ?? undefined,
    });
  }

  const declared = resolved.manifest.assets ?? [];
  const approvals = new Map((await listApprovals(c.env.DB, resolved.manifest.id)).map((a) => [a.path, a]));

  const assets = await Promise.all(declared.map(async (asset) => {
    const approval = approvals.get(asset.path);
    let currentIntegrity: string | null = null;
    let fetchError = false;
    try {
      const upstream = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${asset.path}`);
      if (upstream.ok) currentIntegrity = await computeIntegrity(await upstream.arrayBuffer());
      else fetchError = true;
    } catch {
      fetchError = true;
    }
    const approved = !!approval;
    const drifted = approved && currentIntegrity !== null && currentIntegrity !== approval.integrity;
    return {
      path: asset.path,
      label: asset.label || asset.path,
      approved,
      drifted,
      fetchError,
      approvedBy: approval?.approved_by ?? '',
      integrity: approval?.integrity ?? '',
      approveAction: `/admin/plugins-manage/${id}/assets/approve`,
      revokeAction: `/admin/plugins-manage/${id}/assets/revoke`,
    };
  }));

  return renderPage(c, pluginAssetsPage, {
    pluginId: id,
    pluginLabel: resolved.manifest.name || row.label || row.url,
    unreachable: false,
    assets,
    flash: c.req.query('flash') ?? undefined,
  });
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/approve', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const path = str(form.get('path'));
  const declared = (resolved.manifest.assets ?? []).some((asset) => asset.path === path);
  if (!declared) return c.text('Unknown asset path', 400);

  const upstream = await resolved.fetcher.fetch(`${PLUGIN_ORIGIN}${path}`);
  if (!upstream.ok) return c.redirect(`/admin/plugins-manage/${id}/assets?flash=fetch-failed`);
  const integrity = await computeIntegrity(await upstream.arrayBuffer());
  await approveAsset(c.env.DB, resolved.manifest.id, path, integrity, c.get('user').email);
  logAudit(c, 'plugin.asset.approve', 'plugin', resolved.manifest.id, { path, integrity });
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=approved`);
});

pluginsManageRoutes.post('/plugins-manage/:id/assets/revoke', async (c) => {
  const id = Number(c.req.param('id'));
  const found = await resolvedPluginFor(c.env, id);
  if (!found?.resolved) return c.notFound();
  const { resolved } = found;

  const form = await c.req.formData();
  const path = str(form.get('path'));
  const existing = await getAssetApproval(c.env.DB, resolved.manifest.id, path);
  if (existing) {
    await revokeAsset(c.env.DB, resolved.manifest.id, path);
    logAudit(c, 'plugin.asset.revoke', 'plugin', resolved.manifest.id, { path });
  }
  return c.redirect(`/admin/plugins-manage/${id}/assets?flash=revoked`);
});

/** After any registry mutation, drop the plugin-list, manifest, and merged-config caches. */
function invalidate(): void {
  clearManifestCache();
  clearConfigCache();
}
