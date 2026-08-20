-- Asynchronous answer-quality verdicts (src/db/schema.ts, src/infra/answer-eval.ts).
--
-- One row per completed turn, written AFTER the founder already has the reply.
-- This table records an evaluator, not a guard: nothing here has ever blocked a
-- reply and nothing here may. HITL remains the only gate in the system.
--
-- `status` is the load-bearing column, and the reason the score columns are
-- NULLABLE:
--   'evaluated'     — the judge returned three scores; they are in the columns.
--   'not_evaluated' — the judge was unconfigured, unreachable or unparseable.
--                     Every score is NULL and not_evaluated_reason says why.
-- A judge outage that stored a default score would render as a clean all-clear —
-- the exact failure src/infra/rag-optimization-sweep.ts exists to prevent. NULL
-- can never be mistaken for a pass; a missing reason string cannot either.
--
-- The three dimensions are stored SEPARATELY and must never be averaged into one
-- number: a reply can answer the goal perfectly (relevance 100) while asserting a
-- fact no step result supports (groundedness 0), and that combination is the
-- failure this table exists to surface. Groundedness is the machine-checkable
-- complement to the kernel's receipts mechanism.
--
-- Any rate computed over this table MUST filter `WHERE status = 'evaluated'`, or
-- the denominator silently absorbs every turn the judge never saw.
CREATE TABLE IF NOT EXISTS agents.answer_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,

  turn_id text NOT NULL,
  thread_id text NOT NULL,

  status text NOT NULL,
  not_evaluated_reason text,

  groundedness integer,
  relevance integer,
  completeness integer,
  critique text,

  goal text NOT NULL,
  reply text NOT NULL,
  planned_steps integer NOT NULL DEFAULT 0,

  judge_model text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- Read path for any quality report: "recent verdicts for this tenant".
CREATE INDEX IF NOT EXISTS ae_tenant_created_idx
  ON agents.answer_evaluations (tenant_id, created_at);

-- The outage query — "which turns were never scored" — kept cheap on purpose,
-- because a report that is expensive to run is a report nobody runs.
CREATE INDEX IF NOT EXISTS ae_tenant_status_idx
  ON agents.answer_evaluations (tenant_id, status);

-- Lookup by turn. NOT unique, deliberately: a HITL resume re-runs synthesis under
-- the SAME turn id and produces a second, different answer. A unique index would
-- reject the post-approval answer — the one that actually reached the founder.
CREATE INDEX IF NOT EXISTS ae_turn_idx
  ON agents.answer_evaluations (turn_id);
