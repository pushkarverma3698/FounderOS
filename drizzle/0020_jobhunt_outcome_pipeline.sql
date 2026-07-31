-- 0020 — per-track screening, signals, and posting liveness
--
-- TRACK. `cv_signals` was unique on (tenant_id, term), so "Python 60%" blended
-- AI, backend and frontend into one number. It could be 100% of AI postings and
-- 0% of frontend and the report could not tell them apart — which makes the
-- single highest-value CV finding un-interpretable. The identity becomes
-- (tenant_id, track, term).
--
-- Existing rows backfill to 'unclassified' rather than being guessed into a
-- track. They were accumulated under blended logic and must not masquerade as
-- track data; a wrong track corrupts two gap reports at once, counting a term
-- where it does not belong and missing it where it does.
--
-- LIVENESS. Dedupe answers "have I seen this before". It does not answer "is
-- this still open". A dead posting is currently indistinguishable from a live
-- one in every view we render, and an aggregator's dominant noise is exactly
-- the stale repost. 'unverifiable' is a THIRD value on purpose: treating a
-- network failure as a dead job is the silent direction.

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'unclassified';

-- unknown | live | expired | unverifiable
ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS liveness text NOT NULL DEFAULT 'unknown';

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS liveness_checked_at timestamptz;

-- The source's own id. Indeed's job key is the ONLY handle its liveness lookup
-- accepts; without it an Indeed row could only be checked by fetching its URL,
-- which is the check the aggregator's ghost postings are best at passing.
ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS external_id text;

ALTER TABLE agents.cv_signals
  ADD COLUMN IF NOT EXISTS track text NOT NULL DEFAULT 'unclassified';

-- Dropping the old index first is required, not tidy-up: with (tenant_id, term)
-- still unique, the same term arriving on a second track would collide and the
-- upsert would increment the wrong track's counter.
DROP INDEX IF EXISTS agents.cv_signals_term_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS cv_signals_track_term_uniq
  ON agents.cv_signals (tenant_id, track, term);

-- Per-track gap reports read signals for one track ordered by demand. This
-- supersedes cv_signals_rank_idx, which can no longer serve any query the gap
-- report makes.
CREATE INDEX IF NOT EXISTS cv_signals_track_rank_idx
  ON agents.cv_signals (tenant_id, track, seen_count);

DROP INDEX IF EXISTS agents.cv_signals_rank_idx;

-- The brief's hot path: this track's passing postings, best first.
CREATE INDEX IF NOT EXISTS ja_track_verdict_idx
  ON agents.job_applications (tenant_id, track, salary_status);
