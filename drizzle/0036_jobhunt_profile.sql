-- Migration: 0036_jobhunt_profile.sql
-- Add profile_id column to agents.job_applications for multi-profile job search support.
--
-- SAFETY: the old unique index is on (tenant_id, dedupe_key). We must:
--   1. Add profile_id column first (NOT NULL safe because DEFAULT is set).
--   2. Drop the old index.
--   3. Create the new unique index on (tenant_id, profile_id, dedupe_key).
-- This is safe because all existing rows get DEFAULT 'pushkar-nl-tech',
-- preserving uniqueness for existing data.

ALTER TABLE agents.job_applications
ADD COLUMN IF NOT EXISTS profile_id text DEFAULT 'pushkar-nl-tech';

-- Backfill, then forbid NULL. A NULL does not conflict in a unique index, so a
-- nullable profile_id would silently disable ja_dedupe_uniq for any row that
-- failed to set one — turning the gate that prevents double-applying into a
-- no-op without a single error. Postgres >= 11 fills existing rows from the
-- DEFAULT on ADD COLUMN, so the UPDATE is only for a re-run against a table
-- where the column already existed and was nullable.
UPDATE agents.job_applications SET profile_id = 'pushkar-nl-tech' WHERE profile_id IS NULL;
ALTER TABLE agents.job_applications ALTER COLUMN profile_id SET NOT NULL;

-- Drop old unique constraint (previously only tenant_id + dedupe_key).
DROP INDEX IF EXISTS agents.ja_dedupe_uniq;

-- New unique constraint scoped per-profile so Wife and Pushkar can both screen the same job.
CREATE UNIQUE INDEX IF NOT EXISTS ja_dedupe_uniq
ON agents.job_applications (tenant_id, profile_id, dedupe_key);

-- Multi-profile read index (brief rank lookups scoped to one profile's queue).
CREATE INDEX IF NOT EXISTS ja_profile_idx
ON agents.job_applications (tenant_id, profile_id, brief_section, brief_rank);
