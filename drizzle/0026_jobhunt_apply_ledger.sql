-- When the founder looked at a row and decided NOT to apply.
--
-- `applied_at` already exists and already means "we applied to this" — it has
-- been on the table since the jobhunt schema was created and it drives the
-- re-apply staleness rule in src/tools/jobhunt/screen.ts. This migration adds
-- only its opposite.
--
-- A SEPARATE COLUMN, NEVER A SHARED STATUS. Both events remove a row from the
-- apply queue, so one `handled_at` would serve the queue perfectly well — and
-- would destroy the only number this pipeline exists to move. "I applied and
-- heard nothing back" and "I read this and passed on it" are opposite facts:
-- the first is a live lead and evidence the screening is aimed correctly, the
-- second is evidence it is not. Collapsed into one timestamp, the apply rate
-- loses its denominator and every retrospective question about which roles are
-- worth surfacing becomes unanswerable.
--
-- It must also stay out of `applied_at` specifically because of that staleness
-- rule: stamping a skip there would suppress a role the founder passed on in
-- March and would happily take in September.
--
-- Nullable, no default, no backfill. Every existing row keeps NULL, which is
-- the truth about them — they were screened by a pipeline that had no apply
-- loop. NULL on both columns means "still in the queue", so the 34 stored rows
-- correctly enter it.
--
-- Only the Mac apply client writes this. The machine never submits an
-- application (ADR-009), so it cannot learn either fact except from a founder
-- click — which is exactly what mac-client/apply_queue.py records.
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS skipped_at timestamptz;

-- The apply queue's hot path: unhandled rows for one tenant, best rank first.
-- `applied_at` leads the index because it is the selective predicate — the
-- queue shrinks as the founder works through it, while brief_rank spans the
-- whole table.
CREATE INDEX IF NOT EXISTS ja_apply_queue_idx
  ON agents.job_applications (tenant_id, applied_at, brief_rank);
