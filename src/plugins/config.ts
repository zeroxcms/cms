// ============================================================
// Effective CMS config = static base (cms-config.ts) merged with
// content types contributed by active plugins.
//
// Plugins may only extend blueprint/blocks/blockLists/taxonomies/taxonomyLists.
// languages/defaultLanguage stay site-level (base only), so
// language-only call sites can keep importing the static cmsConfig.
// ============================================================

import { cmsConfig } from '../cms-config';
import type { CmsConfig } from '../cms-config';
import { getPlugins } from './registry';
import { dbPageTypeToContentTypes, listDbPageTypes } from '../utils/page-type-store';
import { dbBlockTypeToContentTypes, listDbBlockTypes } from '../utils/block-type-store';
import type { Env, PluginContentTypes } from '../types';

const CONFIG_TTL_MS = 60_000;
let cached: { config: CmsConfig; expires: number } | null = null;

function mergeContentTypes(base: CmsConfig, fragment: PluginContentTypes | undefined): void {
  if (!fragment) return;
  Object.assign(base.blueprint, fragment.blueprint ?? {});
  Object.assign(base.blocks, fragment.blocks ?? {});
  Object.assign(base.blockLists, fragment.blockLists ?? {});
  Object.assign(base.taxonomies, fragment.taxonomies ?? {});
  Object.assign(base.taxonomyLists, fragment.taxonomyLists ?? {});
}

/**
 * Returns the CmsConfig with plugin- and database-contributed content types
 * merged in, layered base → plugins → database (so a DB page type can override
 * a plugin or config type). Falls back to the static base when neither source
 * contributes anything, keeping the zero-config path unchanged. Cached per
 * isolate with a short TTL.
 */
export async function resolveCmsConfig(env: Env): Promise<CmsConfig> {
  if (cached && cached.expires > Date.now()) return cached.config;

  const plugins = await getPlugins(env);
  const [dbPageTypes, dbBlockTypes] = env.DB
    ? await Promise.all([listDbPageTypes(env.DB), listDbBlockTypes(env.DB)])
    : [[], []];
  if (plugins.length === 0 && dbPageTypes.length === 0 && dbBlockTypes.length === 0) return cmsConfig;

  // Shallow-clone the mutable record fields so we never mutate the base.
  const merged: CmsConfig = {
    defaultLanguage: cmsConfig.defaultLanguage,
    languages: cmsConfig.languages,
    blueprint: { ...cmsConfig.blueprint },
    blocks: { ...cmsConfig.blocks },
    blockLists: { ...cmsConfig.blockLists },
    taxonomies: { ...cmsConfig.taxonomies },
    taxonomyLists: { ...cmsConfig.taxonomyLists },
  };

  for (const plugin of plugins) {
    mergeContentTypes(merged, plugin.manifest.contentTypes);
  }

  for (const pageType of dbPageTypes) {
    mergeContentTypes(merged, dbPageTypeToContentTypes(pageType));
  }

  for (const blockType of dbBlockTypes) {
    mergeContentTypes(merged, dbBlockTypeToContentTypes(blockType));
  }

  cached = { config: merged, expires: Date.now() + CONFIG_TTL_MS };
  return merged;
}

/** Test/dev helper — clears the per-isolate merged-config cache. */
export function clearConfigCache(): void {
  cached = null;
}
