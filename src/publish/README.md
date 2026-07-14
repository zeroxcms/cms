# Publish targets & the shared published DB

Publishing fans a draft-page snapshot out to the targets configured in
`PUBLISH_TARGETS` (default `d1`). See `index.ts` for the registry and
`adapter.ts` for the adapter contract.

## Who writes the published D1 (`cms-published`)

The d1 target's database is shared with public Workers, and row ownership is
strictly partitioned between:

1. **worker-cms (this repo)** — upserts/deletes `live_pages` rows keyed by the
   draft pages' own uuids (`d1.ts`). It must never touch rows whose uuids it
   didn't mint.
2. **External submission Workers** — INSERT-only. They mint their own ids and
   uuids and never update or delete their source rows. `worker-rsvp` is one
   producer, but submissions are not restricted to RSVP page types.

Other public Workers otherwise read the database with parameterized SELECTs
only. The schema is owned here (`migrations/published/`).

## Submission ingest (published → draft)

`src/utils/submission-ingest.ts` treats every published page whose uuid is not
present in `draft_pages` as a submission, regardless of page type. It mirrors
the row with the same uuid (idempotent via the draft uuid unique constraint),
mints a draft id and an `ingest-submission` page version, and fires the
`submission` hook so subscribed plugins can react. Ingest is cron-driven (`wrangler.toml [triggers]`)
and triggerable via `POST /__cms/ingest/submissions` by an authenticated plugin
whose manifest declares `hooks: ["submission"]`.

Invariants the ingest and publish paths preserve:

- **Published submission rows are never mutated or deleted.**
- **Submission mirrors are never publishable or unpublished.** Their existing
  page-version history (`ingest-submission` or `pull-published`) records their
  origin, so `publishPageToTargets` and `unpublishPageFromTargets` can refuse
  them without changing the page schema; page type is irrelevant.
