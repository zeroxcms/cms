// ============================================================
// Database-defined page types.
//
// A row in `page_types` is the runtime-editable equivalent of a
// plugin content-type fragment: it is converted into the same
// PluginContentTypes shape and merged into the effective CmsConfig
// by resolveCmsConfig() (src/plugins/config.ts).
// ============================================================

import type { BlueprintEntry } from '../cms-config';
import type { PageType, PluginContentTypes } from '../types';

/** Loads all database-defined page types, ordered for display. */
export async function listDbPageTypes(db: D1DatabaseClient): Promise<PageType[]> {
  const { results } = await db
    .prepare('SELECT * FROM page_types ORDER BY weight ASC, name ASC')
    .all<PageType>();
  return results;
}

/** Parses a JSON column into the expected shape, or returns the fallback. */
function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

/**
 * Converts a page_types row into a content-type fragment keyed by its slug,
 * so it can flow through the same mergeContentTypes() path as plugin fragments.
 * Malformed JSON is treated as empty rather than throwing.
 */
export function dbPageTypeToContentTypes(row: PageType): PluginContentTypes {
  const fragment: PluginContentTypes = {
    blueprint: { [row.slug]: parseJson<BlueprintEntry[]>(row.blueprint, []) },
  };

  const blockLists = parseJson<string[]>(row.block_lists, []);
  if (blockLists.length > 0) fragment.blockLists = { [row.slug]: blockLists };

  const taxonomyLists = parseJson<string[]>(row.taxonomy_lists, []);
  if (taxonomyLists.length > 0) fragment.taxonomyLists = { [row.slug]: taxonomyLists };

  return fragment;
}
