// ============================================================
// Plugin registry — discovers active plugin Workers from the
// `PLUGINS` env var, fetches and caches their manifests.
//
// Each plugin is a separate Worker bound as a service binding.
// The binding name is listed (comma-separated) in env.PLUGINS,
// e.g. PLUGINS = "PLUGIN_EVENTS,PLUGIN_SEO".
// ============================================================

import type { Env, PluginManifest, ResolvedPlugin } from '../types';

/** Reserved prefix every plugin Worker serves its CMS-facing endpoints under. */
export const PLUGIN_PREFIX = '/__plugin';

/** Synthetic origin used when calling a plugin's service binding. */
export const PLUGIN_ORIGIN = 'https://plugin.local';

// Manifests rarely change between deploys, so cache them per isolate with a
// short TTL (same pattern as templateCache in templates/liquid.ts).
const MANIFEST_TTL_MS = 60_000;
const manifestCache = new Map<string, { manifest: PluginManifest; expires: number }>();

function pluginBindingNames(env: Env): string[] {
  return (env.PLUGINS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

function fetcherFor(env: Env, binding: string): Fetcher | null {
  const candidate = (env as unknown as Record<string, unknown>)[binding];
  if (candidate && typeof (candidate as Fetcher).fetch === 'function') {
    return candidate as Fetcher;
  }
  return null;
}

async function loadManifest(binding: string, fetcher: Fetcher): Promise<PluginManifest | null> {
  const cached = manifestCache.get(binding);
  if (cached && cached.expires > Date.now()) return cached.manifest;

  try {
    const response = await fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/manifest`);
    if (!response.ok) {
      console.error(`Plugin ${binding} manifest returned ${response.status}`);
      return null;
    }
    const manifest = (await response.json()) as PluginManifest;
    manifestCache.set(binding, { manifest, expires: Date.now() + MANIFEST_TTL_MS });
    return manifest;
  } catch (error) {
    console.error(`Plugin ${binding} manifest fetch failed:`, error);
    return null;
  }
}

/** Resolves every active plugin (binding present + manifest reachable). */
export async function getPlugins(env: Env): Promise<ResolvedPlugin[]> {
  const resolved = await Promise.all(
    pluginBindingNames(env).map(async (binding): Promise<ResolvedPlugin | null> => {
      const fetcher = fetcherFor(env, binding);
      if (!fetcher) {
        console.error(`Plugin binding ${binding} listed in PLUGINS but not bound`);
        return null;
      }
      const manifest = await loadManifest(binding, fetcher);
      if (!manifest) return null;
      return { binding, fetcher, manifest };
    }),
  );
  return resolved.filter((plugin): plugin is ResolvedPlugin => plugin !== null);
}

/** Nav items contributed by all plugins, flattened with their plugin id. */
export async function pluginNav(env: Env): Promise<Array<{ pluginId: string; label: string; href: string; roles?: string[] }>> {
  const plugins = await getPlugins(env);
  return plugins.flatMap((plugin) =>
    (plugin.manifest.nav ?? []).map((item) => ({
      pluginId: plugin.manifest.id,
      label: item.label,
      href: `/admin/plugins/${plugin.manifest.id}/${item.href.replace(/^\/+/, '')}`,
      roles: item.roles,
    })),
  );
}

/** Finds the plugin that owns a given field type, if any. */
export async function pluginForFieldType(env: Env, type: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => (plugin.manifest.fieldTypes ?? []).some((field) => field.type === type)) ?? null;
}

/** Resolves a plugin by its manifest id (used by the admin proxy). */
export async function pluginById(env: Env, id: string): Promise<ResolvedPlugin | null> {
  const plugins = await getPlugins(env);
  return plugins.find((plugin) => plugin.manifest.id === id) ?? null;
}

/** Plugins that subscribe to a given lifecycle event. */
export async function pluginsForHook(env: Env, event: string): Promise<ResolvedPlugin[]> {
  const plugins = await getPlugins(env);
  return plugins.filter((plugin) => (plugin.manifest.hooks ?? []).includes(event));
}

/** Test/dev helper — clears the per-isolate manifest cache. */
export function clearManifestCache(): void {
  manifestCache.clear();
}
