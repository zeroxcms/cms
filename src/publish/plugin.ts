// ============================================================
// Plugin publish target — forwards publish traffic to a plugin
// Worker that declared `publishTarget: true` in its manifest.
// This is how external destinations (IPFS, search indexes,
// webhooks, …) plug in without any CMS code changes.
//
// Contract (all POST, JSON body, x-plugin-secret header):
//   /__plugin/publish/page        full PublishSnapshot
//   /__plugin/publish/remove      { uuid }
//   /__plugin/publish/remove-tag  { tagId }
//
// Unlike lifecycle hooks (fire-and-forget), publish calls are
// awaited and a non-2xx response counts as a target failure.
// ============================================================

import type { ResolvedPlugin } from '../types';
import type { PublishAdapter, PublishSnapshot } from './adapter';
import { PLUGIN_ORIGIN, PLUGIN_PREFIX } from '../plugins/registry';

async function post(plugin: ResolvedPlugin, secret: string, tenantId: string, path: string, body: unknown, optional = false): Promise<void> {
  const response = await plugin.fetcher.fetch(`${PLUGIN_ORIGIN}${PLUGIN_PREFIX}/publish/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-plugin-secret': secret,
      ...(tenantId ? { 'x-cms-tenant': tenantId } : {}),
    },
    body: JSON.stringify(body),
  });
  // Optional endpoints (remove-tag) may simply not exist in a plugin.
  if (optional && response.status === 404) return;
  if (!response.ok) {
    throw new Error(`plugin ${plugin.manifest.id} publish/${path} returned ${response.status}`);
  }
}

export function pluginAdapter(plugin: ResolvedPlugin, secret: string, tenantId = ''): PublishAdapter {
  return {
    id: `plugin:${plugin.manifest.id}`,

    async publish(snapshot: PublishSnapshot): Promise<void> {
      await post(plugin, secret, tenantId, 'page', snapshot);
    },

    async unpublish(uuid: string): Promise<void> {
      await post(plugin, secret, tenantId, 'remove', { uuid });
    },

    async removeTag(tagId: number): Promise<void> {
      await post(plugin, secret, tenantId, 'remove-tag', { tagId }, true);
    },
  };
}
