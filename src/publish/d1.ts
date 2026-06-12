// ============================================================
// D1 publish target — the original publish flow, packaged as an
// adapter. Upserts into the published database's live_pages /
// live_page_tags and serves the admin UI's live-state reads.
// ============================================================

import type { LivePageSnapshot, PublishAdapter, PublishSnapshot } from './adapter';

export function d1Adapter(publishedDb: D1Database): PublishAdapter {
  return {
    id: 'd1',

    async publish(snapshot: PublishSnapshot): Promise<void> {
      const { page, tags } = snapshot;
      await publishedDb.prepare(
        `INSERT INTO live_pages (uuid, name, slug, weight, start, end, page_type, lect, page_id, creator, editors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET
           name = excluded.name,
           slug = excluded.slug,
           weight = excluded.weight,
           start = excluded.start,
           end = excluded.end,
           page_type = excluded.page_type,
           lect = excluded.lect,
           page_id = excluded.page_id,
           creator = excluded.creator,
           editors = excluded.editors`,
      )
        .bind(
          page.uuid,
          page.name,
          page.slug,
          page.weight,
          page.start,
          page.end,
          page.page_type,
          page.lect,
          page.page_id,
          page.creator,
          page.editors,
        )
        .run();

      const livePage = await publishedDb.prepare('SELECT id FROM live_pages WHERE uuid = ?')
        .bind(page.uuid)
        .first<{ id: number }>();
      if (!livePage) return;

      await publishedDb.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();

      for (const tag of tags) {
        await publishedDb.prepare(
          'INSERT INTO live_page_tags (uuid, page_id, tag_id, weight) VALUES (?, ?, ?, ?)',
        )
          .bind(tag.uuid, livePage.id, tag.tag_id, tag.weight)
          .run();
      }
    },

    async unpublish(uuid: string): Promise<void> {
      const livePage = await publishedDb.prepare('SELECT id FROM live_pages WHERE uuid = ?')
        .bind(uuid)
        .first<{ id: number }>();
      if (livePage) {
        await publishedDb.prepare('DELETE FROM live_page_tags WHERE page_id = ?').bind(livePage.id).run();
      }

      await publishedDb.prepare('DELETE FROM live_pages WHERE uuid = ?')
        .bind(uuid)
        .run();
    },

    async removeTag(tagId: number): Promise<void> {
      await publishedDb.prepare('DELETE FROM live_page_tags WHERE tag_id = ?').bind(tagId).run();
    },

    async getLiveLect(uuid: string): Promise<string | null> {
      const row = await publishedDb.prepare('SELECT lect FROM live_pages WHERE uuid = ?')
        .bind(uuid)
        .first<{ lect: string | null }>();
      return row?.lect ?? null;
    },

    async liveMap(uuids: string[]): Promise<Map<string, LivePageSnapshot>> {
      if (!uuids.length) return new Map();
      const placeholders = uuids.map(() => '?').join(',');
      const livePages = await publishedDb.prepare(
        `SELECT uuid, lect, weight FROM live_pages WHERE uuid IN (${placeholders})`,
      )
        .bind(...uuids)
        .all<LivePageSnapshot>();
      return new Map(livePages.results.map((page) => [page.uuid, page]));
    },

    async listLiveByTypes(pageTypes: string[]): Promise<LivePageSnapshot[]> {
      if (!pageTypes.length) return [];
      const placeholders = pageTypes.map(() => '?').join(',');
      const livePages = await publishedDb.prepare(
        `SELECT uuid, lect, weight FROM live_pages WHERE page_type IN (${placeholders})`,
      )
        .bind(...pageTypes)
        .all<LivePageSnapshot>();
      return livePages.results;
    },
  };
}
