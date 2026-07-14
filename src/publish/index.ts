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
import { pluginTenantId } from '../security/plugin-proxy';
import { isSubmissionMirror } from '../utils/submission-ingest';
import { projectLect, publishLectRules } from './projection';

export type { LivePageSnapshot, PublishAdapter, PublishSnapshot, PublishSnapshotTag } from './adapter';

export interface PublishOutcome {
  /** Targets that were attempted, in order. */
  targets: string[];
  /** Target ids whose publish/unpublish threw. */
  failures: string[];
  /**
   * Set when the page is a submission mirror: publishing one would upsert the
   * original live row it shares a uuid with, and unpublishing/trashing one
   * would DELETE that live row — so both are refused before reaching any adapter.
   */
  refused?: boolean;
}

const REFUSED_OUTCOME: PublishOutcome = { targets: [], failures: [], refused: true };

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
    adapters.push(pluginAdapter(plugin, plugin.secret, pluginTenantId(env)));
  }

  return adapters;
}

async function buildSnapshot(env: Env, pageId: number): Promise<PublishSnapshot | null> {
  const page = await env.DB.prepare('SELECT * FROM draft_pages WHERE id = ?')
    .bind(pageId)
    .first<Page>();
  if (!page) return null;

  // Data minimization: project the lect BEFORE fan-out so every publish
  // target (D1, R2, plugin targets) receives the same thinned snapshot.
  const rules = await publishLectRules(env);
  page.lect = projectLect(page.lect, rules[page.page_type ?? '']);

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
  if (await isSubmissionMirror(env.DB, pageId)) return REFUSED_OUTCOME;
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.publish(snapshot));
}

/**
 * Removes a page from every configured target. Callers that have the page at
 * hand must pass its submission marker so source mirrors are refused.
 */
export async function unpublishPageFromTargets(env: Env, uuid: string, isSubmission = false): Promise<PublishOutcome> {
  if (isSubmission) return REFUSED_OUTCOME;
  const adapters = await getPublishAdapters(env);
  return runOnAll(adapters, (adapter) => adapter.unpublish(uuid));
}

/** Result of a bulk unpublish: `refusedCount` is how many pages were submission
 *  mirrors (skipped, never deleted), so callers can fold it into their metrics. */
export interface BulkUnpublishOutcome {
  targets: string[];
  failures: string[];
  refusedCount: number;
}

/**
 * Removes many pages from every target in as few round-trips as possible.
 * Adapters that implement unpublishMany() delete in bulk (D1: one batch per
 * chunk; R2: one multi-key delete + a single index rewrite); the rest fall back
 * to unpublish() per uuid. Submission mirrors are refused exactly as in the
 * single-page path — publishing/unpublishing one would touch the shared live
 * row — and counted in `refusedCount` instead of being sent to any adapter.
 */
export async function unpublishPagesFromTargets(
  env: Env,
  pages: Array<{ uuid: string; submission_origin?: number | boolean }>,
): Promise<BulkUnpublishOutcome> {
  const targetable = pages.filter((page) => !page.submission_origin);
  const refusedCount = pages.length - targetable.length;
  const uuids = Array.from(new Set(targetable.map((page) => page.uuid)));
  const adapters = await getPublishAdapters(env);
  const targets = adapters.map((adapter) => adapter.id);
  if (!uuids.length || !adapters.length) return { targets, failures: [], refusedCount };

  const failures: string[] = [];
  const results = await Promise.allSettled(adapters.map((adapter) => (
    adapter.unpublishMany
      ? adapter.unpublishMany(uuids)
      : uuids.reduce<Promise<void>>((prior, uuid) => prior.then(() => adapter.unpublish(uuid)), Promise.resolve())
  )));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failures.push(adapters[index].id);
      console.error(`Publish target ${adapters[index].id} bulk unpublish failed:`, result.reason);
    }
  });
  return { targets, failures, refusedCount };
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
  const combined = new Map<string, LivePageSnapshot>();
  for (let index = 0; index < uuids.length; index += 90) {
    const chunk = uuids.slice(index, index + 90);
    const liveMap = await reader.liveMap!(chunk);
    liveMap.forEach((page, uuid) => combined.set(uuid, page));
  }
  return combined;
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
