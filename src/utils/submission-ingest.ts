// ============================================================
// RSVP submission ingest — published DB → draft pages.
//
// worker-rsvp stores public RSVP responses and self-registrations as
// insert-only rows in the published D1 (`live_pages`, reserved page types
// below, negative ids, uuids the CMS never mints — see src/publish/README.md).
// This module pulls new rows into the draft DB as ordinary pages so they are
// versioned, auditable, and visible to plugins; creating the draft copy fires
// the normal `create` lifecycle hook, which is how cms-plugin-events applies a
// response to its guest page.
//
// Idempotency: the draft copy keeps the source row's uuid, so the draft
// `uuid` unique constraint makes re-ingest a no-op. Progress is tracked by a
// (created_at, uuid) cursor in the settings table; the published rows are
// never mutated or deleted (worker-rsvp reads them for its "already
// responded" check).
//
// Budget: creates per run are capped so one invocation (cron tick or
// /__cms/ingest/submissions call) stays well inside the subrequest budget —
// the next run resumes from the cursor.
// ============================================================

import type { Env } from '../types';
import { deliverHook } from '../plugins/hooks';
import { getSetting, saveSetting } from './settings';
import { savePageVersionAndSetCurrent } from './page-store';

/** Page types worker-rsvp writes into the published DB. Never publishable. */
export const SUBMISSION_PAGE_TYPES = ['rsvp_response', 'rsvp_registration'] as const;

export function isSubmissionPageType(pageType: string | null | undefined): boolean {
  return (SUBMISSION_PAGE_TYPES as readonly string[]).includes(pageType ?? '');
}

const CURSOR_SETTING_KEY = 'submissions.ingest.cursor';
/** Rows scanned from the published DB per run. */
const SCAN_LIMIT = 40;
/** Draft pages created per run (each costs ~4 D1 ops + 1 hook fetch). */
const MAX_CREATES_PER_RUN = 8;

interface LiveSubmissionRow {
  uuid: string;
  created_at: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_type: string;
  lect: string | null;
  page_id: number | null;
}

export interface IngestResult {
  /** Rows read past the cursor this run. */
  scanned: number;
  /** Draft pages created (rows already in draft are skipped silently). */
  created: number;
  /** True when the run stopped at a cap and more rows are waiting. */
  more: boolean;
}

interface Cursor {
  created_at: string;
  uuid: string;
}

function parseCursor(raw: string | null): Cursor {
  if (!raw) return { created_at: '', uuid: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      created_at: typeof parsed.created_at === 'string' ? parsed.created_at : '',
      uuid: typeof parsed.uuid === 'string' ? parsed.uuid : '',
    };
  } catch {
    return { created_at: '', uuid: '' };
  }
}

/**
 * Pulls new submission rows from the published DB into the draft DB. Safe to
 * call concurrently or repeatedly: creation is idempotent by uuid and the
 * cursor only ever moves past handled rows.
 */
export async function ingestSubmissions(env: Env): Promise<IngestResult> {
  if (!env.PUBLISHED_DB) return { scanned: 0, created: 0, more: false };

  const cursor = parseCursor(await getSetting(env, CURSOR_SETTING_KEY));

  const rows = await env.PUBLISHED_DB.prepare(
    `SELECT uuid, created_at, name, slug, weight, start, end, timezone, page_type, lect, page_id
     FROM live_pages
     WHERE page_type IN (${SUBMISSION_PAGE_TYPES.map(() => '?').join(', ')})
       AND (created_at > ? OR (created_at = ? AND uuid > ?))
     ORDER BY created_at ASC, uuid ASC
     LIMIT ?`,
  )
    .bind(...SUBMISSION_PAGE_TYPES, cursor.created_at, cursor.created_at, cursor.uuid, SCAN_LIMIT)
    .all<LiveSubmissionRow>();

  if (!rows.results.length) return { scanned: 0, created: 0, more: false };

  // One query for both pre-checks: which rows already exist in draft, and
  // which parent pages (guest for responses, event for registrations) do.
  const uuids = rows.results.map((row) => row.uuid);
  const parentIds = [...new Set(rows.results.map((row) => row.page_id).filter((id): id is number => id !== null))];
  const existingUuids = new Set(
    (await env.DB.prepare(`SELECT uuid FROM draft_pages WHERE uuid IN (${uuids.map(() => '?').join(', ')})`)
      .bind(...uuids)
      .all<{ uuid: string }>()).results.map((row) => row.uuid),
  );
  const existingParents = new Set(
    parentIds.length
      ? (await env.DB.prepare(`SELECT id FROM draft_pages WHERE id IN (${parentIds.map(() => '?').join(', ')})`)
        .bind(...parentIds)
        .all<{ id: number }>()).results.map((row) => row.id)
      : [],
  );

  let created = 0;
  let handled = 0;
  let last: Cursor = cursor;

  for (const row of rows.results) {
    if (created >= MAX_CREATES_PER_RUN) break;
    handled += 1;
    last = { created_at: row.created_at, uuid: row.uuid };
    if (existingUuids.has(row.uuid)) continue;

    const parentId = row.page_id !== null && existingParents.has(row.page_id) ? row.page_id : null;
    const inserted = await env.DB.prepare(
      `INSERT OR IGNORE INTO draft_pages (uuid, created_at, name, slug, weight, start, end, timezone, page_type, lect, page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(
        row.uuid,
        row.created_at,
        row.name,
        row.slug,
        row.weight,
        row.start,
        row.end,
        row.timezone,
        row.page_type,
        row.lect,
        parentId,
      )
      .first<{ id: number }>();
    if (!inserted) continue; // lost a race to a concurrent run — already ingested

    await savePageVersionAndSetCurrent(env.DB, inserted.id, row.lect, 'ingest-submission');
    created += 1;

    await deliverHook(env, undefined, 'create', {
      id: inserted.id,
      uuid: row.uuid,
      page_type: row.page_type,
      name: row.name,
      slug: row.slug,
    });
  }

  if (last.created_at !== cursor.created_at || last.uuid !== cursor.uuid) {
    await saveSetting(env, CURSOR_SETTING_KEY, JSON.stringify(last));
  }

  return {
    scanned: handled,
    created,
    more: handled < rows.results.length || rows.results.length === SCAN_LIMIT,
  };
}
