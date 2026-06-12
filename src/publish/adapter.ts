// ============================================================
// Publish adapter contract.
//
// Publishing fans a draft snapshot out to one or more targets
// (D1 database, static JSON in R2, plugin Workers → IPFS, …).
// Each target implements this interface; the registry in
// ./index.ts builds the snapshot once and orchestrates the rest.
// ============================================================

import type { Page } from '../types';

/** A published tag link, denormalized so write-only targets (R2 JSON, plugins)
 *  can emit self-contained documents without a database to join against. */
export interface PublishSnapshotTag {
  uuid: string;
  tag_id: number;
  weight: number;
  slug: string | null;
  name: string | null;
}

/** Everything a target needs to materialize one published page. */
export interface PublishSnapshot {
  page: Page;
  tags: PublishSnapshotTag[];
  publishedAt: string;
}

/** Minimal live-page projection the admin UI uses for publish-status badges. */
export interface LivePageSnapshot {
  uuid: string;
  lect: string | null;
  weight: number;
}

export interface PublishAdapter {
  /** Stable identifier used in logs and partial-failure flash messages. */
  id: string;

  /** Create or replace the published copy of a page. Throw on failure. */
  publish(snapshot: PublishSnapshot): Promise<void>;

  /** Remove the published copy of a page. Throw on failure. */
  unpublish(uuid: string): Promise<void>;

  /** Optional: drop a deleted tag from published content. Targets that can't
   *  do this cheaply may omit it — stale tags clear on the next publish. */
  removeTag?(tagId: number): Promise<void>;

  // ── Live-state reads ─────────────────────────────────────────────────────
  // Optional; only the first adapter that implements them serves the admin UI
  // (publish badges, live-vs-draft diffing). Write-only targets omit them.

  getLiveLect?(uuid: string): Promise<string | null>;
  liveMap?(uuids: string[]): Promise<Map<string, LivePageSnapshot>>;
  listLiveByTypes?(pageTypes: string[]): Promise<LivePageSnapshot[]>;
}
