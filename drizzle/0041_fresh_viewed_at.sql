-- fresh_viewed_at: the marker `/fresh` is a delta against.
--
-- 2026-09-08. `/fresh` answers "what has arrived since I last looked", which is
-- a question about the FOUNDER's reading, not about the market — so it needs a
-- per-candidate timestamp that only a founder's own `/fresh` moves.
--
-- On job_lane_heartbeats rather than a new table: the grain is identical (one
-- row per candidate, lane state that must outlive a process restart) and the
-- load/save path already exists. It is written by its own single-column update
-- (`recordFreshView`), never by `saveLaneHeartbeat` — that upsert runs 48 times
-- a day from the sweep and would wipe the founder's marker on the next tick,
-- turning every `/fresh` into `/jobs`.
--
-- NULL until the first run, and that is a meaningful value: `scopeFor` shows
-- everything on file that once and says so, rather than inventing a window and
-- hiding a fortnight of the low-supply lane the one time he had never looked.

ALTER TABLE "agents"."job_lane_heartbeats"
	ADD COLUMN IF NOT EXISTS "fresh_viewed_at" timestamp with time zone;
