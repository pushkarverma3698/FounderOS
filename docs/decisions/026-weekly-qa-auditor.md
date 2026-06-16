# ADR-026: Weekly QA Auditor — deterministic funnel, Claude-judged, PR-only

## Status
Accepted — 2026-06-15

## Context
The inline-bash `weekly-qa-audit.sh` (installed 2026-06-15, never run) had 3 P0 flaws:
opened PRs on a broken build; inverted hallucination detection (flagged honest refusals,
missed confident fabrication — the canonical 2026-06-15 RAG-empty outage); fixed without a
reproducing test. It was also blind to DB state and embedded raw logs (token cost).

## Decision
A 3-stage funnel: deterministic TS harvest+triage (`scripts/log-review/`, unit-tested, zero
Claude tokens) → bounded `digest.json` → single Claude pass that judges hallucination, names
the real failing component, and writes regression-test-first fixes → PR a human merges.

Key decisions: Stage-3 runs on the VPS in an ISOLATED `/opt/founderos-qa` workspace (never the
live deploy); notify = Telegram + Markdown report; diff cap = 3 files / 120 lines; state-checks
reuse `src/db/client.ts` (`getPgPool`) with read-only count helpers; branch named by issue-set
content hash (cross-week dedup); `GITHUB_TOKEN` via `GIT_ASKPASS`.

During implementation, a real scrubbed prod log fixture exposed two field-name assumptions the
design got wrong: prod `time` is an ISO string (not epoch ms), and turn.out `ms` is logged at
the top level (not inside `data`). Both were corrected in `sources.ts`/`timeline.ts` and locked
by fixture-driven guard tests — vindicating the decision to test against real prod data (P2 fix).

The plan's original DB "orphan sends" check joined `dept_signals.idempotency_key`, a column that
does not exist; it was replaced with an embedding-coverage check (rows present but `embedding IS
NULL` — the same silent-fabrication class as an empty store) which uses real columns.

## Consequences
- Raw logs never enter Claude context (token-frugal, reproducible).
- A red build can never become a PR (P0-1). Honest refusals are never punished (P0-2). Every
  fix carries a reproducing test (P0-3, rule #19).
- DB STATE is verified, not just schema (rule #22). First real harvest already surfaced a genuine
  finding: 1 HITL approval stuck pending > 24h.
- Future hardening: container sandbox for Stage-3; Ollama dedup lever. Not built now (YAGNI).
