-- The brief prints "1. Aquablu … → /draft 1". For that handle to mean anything
-- an hour later, the NUMBER the founder read must be pinned to the row he read
-- it against.
--
-- Re-deriving the ranking when /draft fires would be the silent failure: liveness
-- changes and new screens reorder the list, so "2" would resolve to a different
-- job than the one on screen and the founder would draft for the wrong company
-- with no indication anything had shifted.
--
-- Nullable and unindexed by design: only the MOST RECENT brief's rows carry a
-- rank, every render clears the previous set, and the working set is at most
-- DO_TODAY_CAP + ASK_CAP rows.
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS brief_section text;
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS brief_rank integer;

-- One row per (section, rank) per tenant: a duplicate rank would make /draft
-- ambiguous, and picking either row arbitrarily is the wrong kind of guess.
CREATE UNIQUE INDEX IF NOT EXISTS ja_brief_rank_uniq
  ON agents.job_applications (tenant_id, brief_section, brief_rank)
  WHERE brief_section IS NOT NULL;
