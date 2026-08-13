-- failure_lessons occurrence tracking — splits "times_seen" into two axes.
-- Added to src/db/schema.ts on 2026-08-12 (self-improvement audit remediation,
-- see docs/plans/2026-08-12-self-improvement-audit.md, lesson-store-failure-occurrences).
--
-- WHY: src/kernel/lessons.ts's only write path used to be the SUCCESS branch
-- (Hook 1, a retry that settled ok) — `times_seen` was bumped only when a
-- retry actually resolved the failure. A signature that failed identically
-- N times with zero successful retries wrote ZERO rows, so the founder-facing
-- "how often does X fail" question was structurally unanswerable. This
-- migration adds the occurrence axis (`times_seen`, `first_seen_at`,
-- `last_seen_at`) and leaves `times_resolved` to carry the OLD meaning of
-- `times_seen` (a resolution counter), so no historical row's meaning silently
-- changes.
--
-- APPLY (manual — this repo has no automated migration runner in this
-- container; run against the target Postgres):
--   psql "$DATABASE_URL" -f drizzle/0029_lesson_occurrence_tracking.sql
-- REVERT:
--   psql "$DATABASE_URL" -f drizzle/0029_lesson_occurrence_tracking.down.sql
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + the backfill UPDATE is gated on
-- `migrated_from_v1 IS NOT TRUE`, so re-running this file is a safe no-op on a
-- box that already carries the columns and has already been backfilled.

ALTER TABLE agents.failure_lessons
  ADD COLUMN IF NOT EXISTS times_resolved integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS migrated_from_v1 boolean NOT NULL DEFAULT false;

-- Backfill pre-migration rows: under the OLD semantics every row that exists
-- IS a resolution (the only write path was the success branch), so
-- times_resolved = times_seen, first_seen_at = created_at (best available
-- proxy — the row's actual first-occurrence time was never recorded pre-v1),
-- last_seen_at = last_resolved_at (ditto: the last KNOWN activity on the row).
-- Gated on migrated_from_v1 IS NOT TRUE so re-running this file never
-- double-backfills or clobbers counters a post-migration write has already
-- advanced.
UPDATE agents.failure_lessons
SET
  times_resolved = times_seen,
  first_seen_at = created_at,
  last_seen_at = last_resolved_at,
  migrated_from_v1 = true
WHERE migrated_from_v1 IS NOT TRUE;
