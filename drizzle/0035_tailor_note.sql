-- job_applications.tailor_note: give the tailoring failure reason its own column.
--
-- `notes` had two writers. `recordTailoringResult` put the reason a CV build
-- failed there, and `recordLiveness` overwrites that same column with its own
-- sentence on every brief render — which happens far more often than a
-- tailoring attempt does.
--
-- Measured on production, 2026-08-24: 16 rows carried `tailor_status='failed'`
-- and **14 of them read "Confirmed still open: HTTP 200"** or "Could not confirm
-- still open (Indeed job key …)". Both are true statements about liveness and
-- neither says anything about why the CV was never built. The two reasons that
-- did survive — a Gemini 5xx and a missing Playwright Chromium — are precisely
-- the two classes of failure worth acting on, and they survived by luck of
-- ordering rather than by design.
--
-- NULLABLE with no default, and no backfill. The 14 reasons are gone; writing a
-- placeholder into them would manufacture a record of something nobody
-- observed. NULL reads as "no tailoring attempt has reported here", which is
-- the honest state for every row that has never been drafted.
--
-- IF NOT EXISTS so a re-run is a no-op.

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS tailor_note text;
