// ============================================================
// Effective CMS config = static base (cms-config.ts) merged with
// content types contributed by active plugins.
//
// Plugins may only extend blueprint/blocks/blockLists/tagLists.
// languages/defaultLanguage stay site-level (base only), so
// language-only call sites can keep importing the static cmsConfig.
// ============================================================

import { cmsConfig } from '../cms-config';
import type { CmsConfig } from '../cms-config';
import { getPlugins } from './registry';
import type { Env, PluginContentTypes } from '../types';

const CONFIG_TTL_MS = 60_000;
let cached: { config: CmsConfig; expires: number } | null = null;

function mergeContentTypes(base: CmsConfig, fragment: PluginContentTypes | undefined): void {
  if (!fragment) return;
  Object.assign(base.blueprint, fragment.blueprint ?? {});
  Object.assign(base.blocks, fragment.blocks ?? {});
  Object.assign(base.blockLists, fragment.blockLists ?? {});
  Object.assign(base.tagLists, fragment.tagLists ?? {});
}

/**
 * Returns the CmsConfig with plugin-contributed content types merged in.
 * Falls back to the static base when no plugins are configured, so the
 * zero-plugin path is unchanged. Cached per isolate with a short TTL.
 */
export async function resolveCmsConfig(env: Env): Promise<CmsConfig> {
  if (!env.PLUGINS) return cmsConfig;
  if (cached && cached.expires > Date.now()) return cached.config;

  const plugins = await getPlugins(env);
  if (plugins.length === 0) return cmsConfig;

  // Shallow-clone the mutable record fields so we never mutate the base.
  const merged: CmsConfig = {
    defaultLanguage: cmsConfig.defaultLanguage,
    languages: cmsConfig.languages,
    blueprint: { ...cmsConfig.blueprint },
    blocks: { ...cmsConfig.blocks },
    blockLists: { ...cmsConfig.blockLists },
    tagLists: { ...cmsConfig.tagLists },
  };

  for (const plugin of plugins) {
    mergeContentTypes(merged, plugin.manifest.contentTypes);
  }

  cached = { config: merged, expires: Date.now() + CONFIG_TTL_MS };
  return merged;
}

/** Test/dev helper — clears the per-isolate merged-config cache. */
export function clearConfigCache(): void {
  cached = null;
}
