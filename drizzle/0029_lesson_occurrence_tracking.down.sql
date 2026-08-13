-- Down migration for drizzle/0029_lesson_occurrence_tracking.sql.
-- This repo's drizzle-kit journal is forward-only (no down-migration
-- precedent anywhere in ./drizzle/) and there is no automated runner for
-- this file — apply it by hand if 0029 needs to be reverted:
--   psql "$DATABASE_URL" -f drizzle/0029_lesson_occurrence_tracking.down.sql
--
-- Exact inverse of 0029: drops the four columns it added, nothing else.
-- Safe to run even if 0029 was only partially applied (IF EXISTS on every
-- column) or already reverted (idempotent no-op).

ALTER TABLE agents.failure_lessons
  DROP COLUMN IF EXISTS times_resolved,
  DROP COLUMN IF EXISTS first_seen_at,
  DROP COLUMN IF EXISTS last_seen_at,
  DROP COLUMN IF EXISTS migrated_from_v1;
