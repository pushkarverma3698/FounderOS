-- Evolution Engine self-audit memory (src/db/schema.ts, src/evolution/persist-findings.ts).
--
-- NUMBERED 0030, NOT 0029, DELIBERATELY: drizzle/0029_lesson_occurrence_tracking.sql
-- was authored in parallel on a sibling branch (same remediation plan, separate PR).
-- Both originally claimed idx 29 with an identical `when`, so the only line that
-- differed in their _journal.json entries was `"tag"` — git therefore produced a
-- ONE-LINE conflict, and the natural "keep both sides" resolution yields a single
-- entry carrying a DUPLICATE "tag" key. JSON parsers keep the last one, so one
-- migration silently vanishes from the journal and is never applied — the exact
-- inert-migration failure mode that cost 11 days of production breakage (see the
-- header of tests/unit/db/schema-migration-parity.test.ts). Distinct idx + `when`
-- makes the conflict multi-line, so "keep both" is both obvious and correct.
--
-- Closes "Cut 2" from docs/plans/2026-08-12-self-improvement-audit.md §3: no
-- findings table existed anywhere, so every audit run started from zero and
-- could not tell a brand-new finding from one seen 40 times, or one that was
-- fixed and has now regressed.
--
-- evolution_runs — one row per audit/acting invocation. analyzers_run records
-- which analyzer FUNCTION NAMES actually executed that run, so a later reader
-- can tell "this analyzer ran and found nothing" from "this analyzer did not
-- run at all" — the distinction the resolution rule below depends on.
CREATE TABLE IF NOT EXISTS agents.evolution_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,

  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,

  commit_sha text,
  loop text NOT NULL,

  findings_count integer NOT NULL DEFAULT 0,
  outcome text,

  analyzers_run jsonb NOT NULL DEFAULT '[]'
);

-- evolution_findings — one row per (tenant, fingerprint). See src/db/schema.ts
-- for the full status-machine doc (open / resolved / regressed) and
-- src/evolution/fingerprint.ts for what the fingerprint hashes (kind +
-- location + subject — deliberately NOT the free-text evidence sentence,
-- which embeds volatile numbers that change every run without the underlying
-- defect changing).
CREATE TABLE IF NOT EXISTS agents.evolution_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,

  fingerprint text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  location text,
  subject text NOT NULL,
  analyzer text NOT NULL,
  detail text NOT NULL,

  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  times_seen integer NOT NULL DEFAULT 1,

  status text NOT NULL DEFAULT 'open',
  resolved_at timestamptz,

  run_id uuid REFERENCES agents.evolution_runs(id)
);

-- Upsert hot path: one row per (tenant, fingerprint) — see
-- upsertEvolutionFinding in src/db/queries.ts.
CREATE UNIQUE INDEX IF NOT EXISTS ef_tenant_fingerprint_idx
  ON agents.evolution_findings (tenant_id, fingerprint);

-- Resolution-path lookup: "this analyzer's prior open/regressed rows" — see
-- resolveMissingEvolutionFindings in src/db/queries.ts.
CREATE INDEX IF NOT EXISTS ef_tenant_analyzer_idx
  ON agents.evolution_findings (tenant_id, analyzer, status);
