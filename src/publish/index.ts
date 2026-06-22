// ============================================================
// Publish registry — resolves the configured publish targets
// and orchestrates publish / unpublish across all of them.
//
// Built-in targets come from the comma-separated PUBLISH_TARGETS
// var (default "d1"): "d1" needs the PUBLISHED_DB binding, "r2"
// needs the PUBLISH_BUCKET binding. Plugin targets are discovered
// from plugin manifests (publishTarget: true), mirroring how
// lifecycle hooks are wired.
//
// The draft snapshot is built once from DB and fanned out to every
// target; per-target failures are collected (not thrown) so the
// admin can report partial publishes. The first adapter that
// implements live-state reads serves the admin UI's publish badges.
// ============================================================

import type { Env, Page } from '../types';
import type { LivePageSnapshot, PublishAdapter, PublishSnapshot, PublishSnapshotTag } from './adapter';
import { d1Adapter } from './d1';
import { r2Adapter } from './r2';
import { pluginAdapter } from './plugin';
import { getPlugins } from '../plugins/registry';

export type { LivePageSnapshot, PublishAdapter, PublishSnapshot, PublishSnapshotTag } from './adapter';

export interface PublishOutcome {
  /** Targets that were attempted, in order. */
  targets: string[];
  /** Target ids whose publish/unpublish threw. */
  failures: string[];
}

const DEFAULT_TARGETS = 'd1';

export async function getPublishAdapters(env: Env): Promise<PublishAdapter[]> {
  const adapters: PublishAdapter[] = [];

  const targets = (env.PUBLISH_TARGETS ?? DEFAULT_TARGETS)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  for (const target of targets) {
    if (target === 'd1') {
      if (env.PUBLISHED_DB) adapters.push(d1Adapter(env.PUBLISHED_DB));
      else console.error('Publish target "d1" requires the PUBLISHED_DB binding');
    } else if (target === 'r2') {
      if (env.PUBLISH_BUCKET) adapters.push(r2Adapter(env.PUBLISH_BUCKET));
      else console.error('Publish target "r2" requires the PUBLISH_BUCKET binding');
    } else {
      console.error(`Unknown publish target "${target}" in PUBLISH_TARGETS`);
    }
  }

  const plugins = await getPlugins(env);
  for (const plugin of plugins.filter((candidate) => candidate.manifest.publishTarget)) {
    if (!plugin.secret) {
      console.error(`Plugin ${plugin.manifest.id} declares publishTarget but has no secret configured`);
      continue;
    }
    adapters.push(pluginAdapter(plugin, plugin.secret));
  }

  return adapters;
}

async function buildSnapshot(env: Env, pageId: number): Promise<PublishSnapshot | null> {
  const page = await env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return null;

  const tags = await env.DB.prepare(
    `SELECT pt.uuid, pt.tag_id, pt.weight, t.slug, t.name
     FROM draft_page_tags pt
     LEFT JOIN tags t ON t.id = pt.tag_id
     WHERE pt.page_id = ?
     ORDER BY pt.weight ASC, pt.id ASC`,
  )
    .bind(pageId)
    .all<PublishSnapshotTag>();

  return { page, tags: tags.results, publishedAt: new Date().toISOString() };
}

async function runOnAll(
  adapters: PublishAdapter[],
  run: (adapter: PublishAdapter) => Promise<void>,
): Promise<PublishOutcome> {
  const results = await Promise.allSettled(adapters.map((adapter) => run(adapter)));
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} failed:`, result.reason);
    }
  });
  return { targets: adapters.map((adapter) => adapter.id), failures };
}

/** Publishes a draft page to every configured target. Null when the draft is missing. */
export async function publishPageToTargets(env: Env, pageId: number): Promise<PublishOutcome | null> {
  const snapshot = await buildSnapshot(env, pageId);
  if (!snapshot) return null;
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.publish(snapshot));
}

/** Removes a page from every configured target. */
export async function unpublishPageFromTargets(env: Env, uuid: string): Promise<PublishOutcome> {
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.unpublish(uuid));
}

/** Drops a deleted tag from targets that support it (best effort elsewhere). */
export async function removeTagFromTargets(env: Env, tagId: number): Promise<PublishOutcome> {
  const adapters = (await getPublishAdapters(env)).filter((adapter) => adapter.removeTag);
  return runOnAll(adapters, (adapter) => adapter.removeTag!(tagId));
}

/** First configured adapter that can answer live-state reads, if any. */
async function liveReader(env: Env): Promise<PublishAdapter | null> {
  const adapters = await getPublishAdapters(env);
  return adapters.find((adapter) => adapter.liveMap && adapter.getLiveLect && adapter.listLiveByTypes) ?? null;
}

export async function getLiveLect(env: Env, uuid: string): Promise<string | null> {
  const reader = await liveReader(env);
  return reader ? reader.getLiveLect!(uuid) : null;
}

export async function liveMapForDraftPages(env: Env, draftPages: Page[]): Promise<Map<string, LivePageSnapshot>> {
  const reader = await liveReader(env);
  if (!reader) return new Map();
  const uuids = Array.from(new Set(draftPages.map((page) => page.uuid)));
  if (!uuids.length) return new Map();
  return reader.liveMap!(uuids);
}

export async function listLiveByTypes(env: Env, pageTypes: string[]): Promise<LivePageSnapshot[]> {
  const reader = await liveReader(env);
  return reader ? reader.listLiveByTypes!(pageTypes) : [];
}

/** Human-readable flash fragment for a partially failed publish. */
export function describeFailures(outcome: PublishOutcome): string | null {
  if (!outcome.failures.length) return null;
  return outcome.failures.join(', ');
}
