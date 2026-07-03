// Shared helpers for the page-type and block-type admin routes, which manage
// parallel tables (page_types / block_types) with identical validation and
// config-vs-DB listing rules.

import type { AppContext } from './context';
import type { ResolvedPlugin } from '../types';

export interface ConfigTypeRow {
  slug: string;
  name: string;
  source: 'plugin' | 'config';
  pluginName: string;
}

/**
 * Read-only rows for the type listings: everything in the resolved config that
 * isn't a DB row — static config-file entries plus those contributed by active
 * plugins. Plugins are merged in registry order, so the last declaration is
 * the effective source when two plugins define the same slug.
 */
export function configOnlyTypes(
  resolvedSlugs: string[],
  dbSlugs: Set<string>,
  plugins: ResolvedPlugin[],
  manifestTypes: (plugin: ResolvedPlugin) => Record<string, unknown> | undefined,
): ConfigTypeRow[] {
  const pluginNameBySlug = new Map<string, string>();
  for (const plugin of plugins) {
    for (const slug of Object.keys(manifestTypes(plugin) ?? {})) {
      pluginNameBySlug.set(slug, plugin.manifest.name);
    }
  }
  return resolvedSlugs
    .filter((slug) => !dbSlugs.has(slug))
    .map((slug) => {
      const pluginName = pluginNameBySlug.get(slug) ?? '';
      return { slug, name: slug, source: pluginName ? 'plugin' : 'config', pluginName };
    });
}

/** Validates a page/block type form submission; returns an error message or
 *  null. `ignoreId` skips the row being edited during the slug-collision check. */
export async function validateTypeForm(
  c: AppContext,
  opts: {
    name: string;
    slug: string;
    blueprint: string;
    table: 'page_types' | 'block_types';
    /** The config-file map the slug must not collide with (blueprint / blocks). */
    configSlugs: Record<string, unknown>;
    ignoreId?: number;
  },
): Promise<string | null> {
  const { name, slug, blueprint, table, configSlugs, ignoreId } = opts;
  if (!name) return 'Name is required.';
  if (!slug) return 'Slug is required.';
  if (slug in configSlugs) return `Slug "${slug}" is already defined in the config file.`;

  const existing = await c.env.DB.prepare(`SELECT id FROM ${table} WHERE slug = ?`)
    .bind(slug)
    .first<{ id: number }>();
  if (existing && existing.id !== ignoreId) return `Slug "${slug}" is already in use.`;

  try {
    const parsed = JSON.parse(blueprint || '[]');
    if (!Array.isArray(parsed)) return 'Blueprint must be a JSON array.';
  } catch {
    return 'Blueprint is not valid JSON.';
  }
  return null;
}
