// ============================================================
// Effective CMS config = static base (cms-config.ts) merged with
// content types contributed by active plugins.
//
// Plugins extend content types; the database locale registry extends the
// content-language list. `mis` remains the site-level default.
// ============================================================

import { cmsConfig } from '../cms-config';
import type { CmsConfig } from '../cms-config';
import { getPlugins } from './registry';
import {
  applyPageTypeExtensions,
  dbPageTypeToContentTypes,
  listDbPageTypes,
  loadPageTypeExtensions,
} from '../utils/page-type-store';
import { dbBlockTypeToContentTypes, listDbBlockTypes } from '../utils/block-type-store';
import type { Env, PluginContentTypes } from '../types';
import { DEFAULT_CONTENT_LANGUAGE, localeRegistry } from '../utils/i18n';

const CONFIG_TTL_MS = 60_000;
let cached: { config: CmsConfig; expires: number } | null = null;

function mergeContentTypes(base: CmsConfig, fragment: PluginContentTypes | undefined): void {
  if (!fragment) return;
  safeAssign(base.blueprint, fragment.blueprint);
  safeAssign(base.blocks, fragment.blocks);
  safeAssign(base.blockLists, fragment.blockLists);
  safeAssign(base.taxonomies, fragment.taxonomies);
  safeAssign(base.taxonomyLists, fragment.taxonomyLists);
}

function safeAssign<T>(target: Record<string, T>, source: Record<string, T> | undefined): void {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    target[key] = value;
  }
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
  const [dbPageTypes, dbBlockTypes, registry, extensions] = env.DB
    ? await Promise.all([
        listDbPageTypes(env.DB),
        listDbBlockTypes(env.DB),
        localeRegistry(env),
        loadPageTypeExtensions(env),
      ])
    : [[], [], { contentLanguages: cmsConfig.languages }, {}];

  // Shallow-clone the mutable record fields so we never mutate the base.
  const merged: CmsConfig = {
    defaultLanguage: DEFAULT_CONTENT_LANGUAGE,
    languages: registry.contentLanguages.length ? registry.contentLanguages : cmsConfig.languages,
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

  // Last: extensions ADD to (never replace) whatever the layers above produced.
  applyPageTypeExtensions(merged, extensions);

  cached = { config: merged, expires: Date.now() + CONFIG_TTL_MS };
  return merged;
}

/** Test/dev helper — clears the per-isolate merged-config cache. */
export function clearConfigCache(): void {
  cached = null;
}
