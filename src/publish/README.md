# Publish targets & the shared published DB

Publishing fans a draft-page snapshot out to the targets configured in
`PUBLISH_TARGETS` (default `d1`). See `index.ts` for the registry and
`adapter.ts` for the adapter contract.

## Who writes the published D1 (`cms-published`)

The d1 target's database is shared with public Workers, and it has **two
writers with strictly partitioned row ownership**:

1. **worker-cms (this repo)** — upserts/deletes `live_pages` rows keyed by the
   draft pages' own uuids (`d1.ts`). It must never touch rows whose uuids it
   didn't mint.
2. **worker-rsvp** — INSERT-only. Public RSVP submissions land as rows with
   `page_type` `rsvp_response` / `rsvp_registration`, **negative ids** (so they
   can never collide with CMS page ids, which are positive), and uuids the CMS
   never sees. worker-rsvp never updates or deletes anything.

worker-web and worker-rsvp otherwise read the database with parameterized
SELECTs only. The schema is owned here (`migrations/published/`).

## Submission ingest (published → draft)

`src/utils/submission-ingest.ts` pulls new submission rows into the draft DB
as ordinary pages — same uuid (idempotent via the draft uuid unique
constraint), draft-minted positive id, `create` hook fired so plugins (the
events plugin) can react. Cron-driven (`wrangler.toml [triggers]`) and
triggerable via `POST /__cms/ingest/submissions` (plugin-secret auth, caller
must own the submission page types).

Invariants the ingest and publish paths preserve:

- **Published submission rows are never mutated or deleted** — worker-rsvp
  reads them on the public path (the "already responded" check).
- **Submission page types are never publishable and never unpublished**
  (`publishPageToTargets` / `unpublishPageFromTargets` refuse them): the draft
  copy shares its uuid with the source row, so publishing would upsert the
  original and unpublishing/trashing would DELETE it.
- The CMS must never mint draft pages with the submission page types itself —
  they exist in draft only as ingested mirrors.
