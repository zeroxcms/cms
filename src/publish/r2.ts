// ============================================================
// R2 publish target — materializes published content as static
// JSON objects so a bucket (optionally fronted by a custom
// domain / CDN) can serve the site with no database at all.
//
// Layout inside the bucket (under an optional key prefix):
//   pages/<uuid>.json  full page snapshot, lect parsed to JSON
//   index.json         light listing of every live page
//
// Writes are last-publish-wins; concurrent publishes can race on
// index.json, which self-heals on the next publish/unpublish.
// ============================================================

import type { LivePageSnapshot, PublishAdapter, PublishSnapshot } from './adapter';
import { safeParseLect } from '../utils/lect';

interface IndexEntry {
  uuid: string;
  name: string;
  slug: string;
  page_type: string | null;
  weight: number;
  published_at: string;
}

interface PublishIndex {
  generated_at: string;
  pages: IndexEntry[];
}

const JSON_HEADERS = { httpMetadata: { contentType: 'application/json; charset=utf-8' } };

export function r2Adapter(bucket: R2Bucket, prefix = ''): PublishAdapter {
  const pageKey = (uuid: string) => `${prefix}pages/${uuid}.json`;
  const indexKey = `${prefix}index.json`;

  async function readIndex(): Promise<PublishIndex> {
    const object = await bucket.get(indexKey);
    if (!object) return { generated_at: new Date().toISOString(), pages: [] };
    try {
      return (await object.json()) as PublishIndex;
    } catch {
      return { generated_at: new Date().toISOString(), pages: [] };
    }
  }

  async function writeIndex(pages: IndexEntry[]): Promise<void> {
    const index: PublishIndex = { generated_at: new Date().toISOString(), pages };
    await bucket.put(indexKey, JSON.stringify(index), JSON_HEADERS);
  }

  async function readPage(uuid: string): Promise<Record<string, unknown> | null> {
    const object = await bucket.get(pageKey(uuid));
    if (!object) return null;
    try {
      return (await object.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function liveMap(uuids: string[]): Promise<Map<string, LivePageSnapshot>> {
    const entries = await Promise.all(
      uuids.map(async (uuid): Promise<[string, LivePageSnapshot] | null> => {
        const document = await readPage(uuid);
        if (!document) return null;
        return [uuid, {
          uuid,
          lect: document.lect === undefined || document.lect === null ? null : JSON.stringify(document.lect),
          weight: typeof document.weight === 'number' ? document.weight : 0,
        }];
      }),
    );
    return new Map(entries.filter((entry): entry is [string, LivePageSnapshot] => entry !== null));
  }

  return {
    id: 'r2',

    async publish(snapshot: PublishSnapshot): Promise<void> {
      const { page, tags, publishedAt } = snapshot;
      const document = {
        uuid: page.uuid,
        name: page.name,
        slug: page.slug,
        weight: page.weight,
        start: page.start,
        end: page.end,
        page_type: page.page_type,
        lect: safeParseLect(page.lect),
        tags: tags.map((tag) => ({ uuid: tag.uuid, tag_id: tag.tag_id, weight: tag.weight, slug: tag.slug, name: tag.name })),
        published_at: publishedAt,
      };
      await bucket.put(pageKey(page.uuid), JSON.stringify(document), JSON_HEADERS);

      const index = await readIndex();
      const entry: IndexEntry = {
        uuid: page.uuid,
        name: page.name,
        slug: page.slug,
        page_type: page.page_type,
        weight: page.weight,
        published_at: publishedAt,
      };
      await writeIndex([...index.pages.filter((existing) => existing.uuid !== page.uuid), entry]);
    },

    async unpublish(uuid: string): Promise<void> {
      await bucket.delete(pageKey(uuid));
      const index = await readIndex();
      await writeIndex(index.pages.filter((existing) => existing.uuid !== uuid));
    },

    // removeTag is intentionally omitted: rewriting every page object on tag
    // deletion is unbounded; stale tag links clear when a page republishes.

    async getLiveLect(uuid: string): Promise<string | null> {
      const document = await readPage(uuid);
      if (!document || document.lect === undefined || document.lect === null) return null;
      return JSON.stringify(document.lect);
    },

    liveMap,

    async listLiveByTypes(pageTypes: string[]): Promise<LivePageSnapshot[]> {
      const index = await readIndex();
      const uuids = index.pages
        .filter((entry) => pageTypes.includes(entry.page_type ?? ''))
        .map((entry) => entry.uuid);
      return Array.from((await liveMap(uuids)).values());
    },
  };
}
