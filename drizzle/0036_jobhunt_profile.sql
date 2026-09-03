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

-- Drop old unique constraint (previously only tenant_id + dedupe_key).
DROP INDEX IF EXISTS agents.ja_dedupe_uniq;

-- New unique constraint scoped per-profile so Wife and Pushkar can both screen the same job.
CREATE UNIQUE INDEX IF NOT EXISTS ja_dedupe_uniq
ON agents.job_applications (tenant_id, profile_id, dedupe_key);

-- Multi-profile read index (brief rank lookups scoped to one profile's queue).
CREATE INDEX IF NOT EXISTS ja_profile_idx
ON agents.job_applications (tenant_id, profile_id, brief_section, brief_rank);
