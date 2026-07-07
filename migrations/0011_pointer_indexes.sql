-- Pointer lookups (GET /__cms/pages?pointer_key=...) were full table scans:
-- D1 evaluated json_extract(lect, ...) on every draft_pages row, which blew the
-- per-request CPU budget (Cloudflare 1102) once a guest list reached thousands
-- of rows. Expression indexes turn the common pointer filters into index
-- lookups, with the query's ORDER BY updated_at DESC, id DESC served straight
-- from the index. NOTE: SQLite only uses an expression index when the query
-- spells the expression out literally — cms-api.ts inlines the (validated)
-- pointer path instead of binding it as a parameter.
CREATE INDEX IF NOT EXISTS idx_draft_pages_pointer_mail_list
  ON draft_pages(json_extract(lect, '$._pointers.mail_list'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_draft_pages_pointer_event
  ON draft_pages(json_extract(lect, '$._pointers.event'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_draft_pages_pointer_edm
  ON draft_pages(json_extract(lect, '$._pointers.edm'), page_type, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_draft_pages_pointer_contact
  ON draft_pages(json_extract(lect, '$._pointers.contact'), page_type, updated_at DESC, id DESC);
