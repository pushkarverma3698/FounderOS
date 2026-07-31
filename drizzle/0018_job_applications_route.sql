-- Two-track screening: the campaign's highest-EV channel is a remote contract
-- that needs no sponsor and has no permit salary floor, so a posting's route
-- decides which gates apply. Recorded per row so a verdict can be read back
-- against the gates that actually produced it.
--
-- `soft_dedupe_key` is company + sorted title words with cosmetic noise removed.
-- Deliberately NOT unique: sorting tokens can merge genuinely distinct roles, so
-- it raises a warning while `ja_dedupe_uniq` remains what prevents a double
-- application.

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS soft_dedupe_key text;

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS route text NOT NULL DEFAULT 'hsm';

-- Re-post detection scans by soft key within a tenant.
CREATE INDEX IF NOT EXISTS ja_soft_dedupe_idx
  ON agents.job_applications (tenant_id, soft_dedupe_key);
