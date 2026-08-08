# Failure Ledger

Every defect found during the 2026-08-08 audit. **None fixed this session, by design.**
Each entry: evidence, impact, and the phase that owns it.

Severity: **P0** founder-visible outcome failure · **P1** silent correctness/safety ·
**P2** maintainability.

---

## F-01 · P0 · Free job lane screens 0 of ~20,550 candidates, every sweep

**Evidence** — prod journalctl, ~144 consecutive sweeps since at least 2026-08-05:
```
Aug 08 09:30:19  jobhunt:free-ingest  boards=285  seen=20554  screened=0  failed=0
```
Corroboration: `job_applications` 39 rows in 8 days; `free-ats-ingest` 5 rows; `applied_at not
null` = **2** lifetime; prod trace 05:31:57Z `cv_gaps` → *"built from 1 passing posting(s)"*.

**Impact** — the flagship autonomous capability produces nothing while reporting continuous work.

**ROOT-CAUSED 2026-08-08** via `scripts/diagnose-free-funnel.ts` (read-only, all 285 live boards):
the `FREE_LANE_MAX_AGE_HOURS = 6` gate drops **18,865 of 18,888 (99.9%)**; the 5 survivors then
fail the track classifier, leaving 0. The gate's premise — *"older than 6h ⇒ seen in an earlier
sweep"* — was never true, because the gate itself rejected the back catalogue before `keepUnseen`
could record it. **A bootstrap deadlock.** Measured supply: 7d → 34, 30d → 132.

The deeper defect is that an **age gate is being used as a dedup mechanism**. Widening the window
alone reproduces the same bug at a larger number.

**Owner:** Phase 1.

## F-02 · P0 · Funnel diagnostics computed then discarded

`filterCandidates` returns per-reason drop counts in `notes[]`. On a quiet sweep — which is every
sweep — nothing renders them. The system computes the evidence of its own failure and throws it
away, which is why F-01 ran undetected for days.

**Owner:** Phase 1.

## F-03 · P0 · False success — "Mission complete" on an unmet objective

Prod turn `a194c5e5` 2026-08-08T05:23:48Z:
> `Mission complete. Here is the CSV data for the captured jobs:\n\ncompany,role,status\nAdyen,…`

39 rows exist; ~3 named; 3 of ~40 columns; no file; no count. `VERIFIERS` has no `jobhunt` entry
and no mission-level check exists.

**Owner:** Phase 4.

## F-04 · P0 · No capability reads the system's own structured state

39 job rows in Postgres are unreachable by any tool. The worker substituted `job_brief` — the
nearest-sounding tool — and returned prose. **A missing capability degrades into a plausible
wrong one, silently.** Same gap for schedules, costs, approvals, action log.

**Owner:** Phase 2.

## F-05 · P0 · No artifact create → deliver path

- `write_artifact`: admin-only, hardcoded `.md` (`src/tools/artifact.ts`), writes to `./artifacts`
- `/opt/founderos/artifacts` **does not exist on prod** (verified)
- `send_file`: personal-only, path-guarded to `personalRoot()` = `/home/founderos`

Different workers, disjoint roots, wrong extension. No plan can join them.

**Owner:** Phase 3.

## F-06 · P0 · `write_artifact` reports success without checking the write

Returns `✅ Artifact "<title>" written successfully` immediately after `fs.writeFile`, with no
`stat`, into a directory that does not exist in production.

**Owner:** Phase 3 (+ Phase 4 observation).

## F-07 · P1 · `synthesize_skill` writes executable TypeScript into the running prod source tree

`src/tools/skill-synthesizer.ts` writes to `./src/tools/custom` and `./tests/unit/tools/custom`,
then compiles. Exposed on **admin, engineering**, and admin's `memory_context` cluster.
**Not in `HITL_GATED_TOOLS`.**

An LLM can author and compile code into the live application without founder approval. No
sandbox, no review, no approval gate.

**Recommendation:** gate it behind HITL and a config flag, or disable it in production. Not a
roadmap phase — a decision the founder should make. **See "Outstanding from your end" #2.**

## F-08 · P1 · `VERIFIERS` covers 1 of 8 workers

`src/kernel/verify.ts` — one entry (`comms`, regex placeholder check). The seam is correctly wired
into `worker.ts`; the map is empty for admin, research, engineering, marketing, sales, personal,
jobhunt.

**Owner:** Phase 4.

## F-09 · P1 · `writeTaskOutcome` has zero production callers

`src/db/queries.ts:528`. Only `tests/helpers/mock-db.ts` references it.
`agents.agent_results`: **0 rows**. The system cannot measure its own completion rate — which is
why the only quality number available is a 29% routing eval.

**Owner:** Phases 4 (call it) + 11 (use it).

## F-10 · P1 · ContextComposer is complete, tested, and called by nothing

`src/kernel/context-composer.ts` — 88 LOC implementing a 5-layer memory hierarchy with
multi-signal ranking. Only importer: `tests/unit/kernel/context-composer.test.ts`.
**Fourth confirmed instance of build-and-never-wire.**

**Owner:** Phase 6 — wire or delete, explicitly.

## F-11 · P1 · Tools report actions, never observations

`browser` click returns stdout with no page-state check. `github_write` returns a success message
with no remote verification. `claude_code` returns agent output with no test result. Nothing
distinguishes *attempted* from *happened*.

**Owner:** Phase 4.

## F-12 · P1 · No mission-level completion check

`OUTPUT_CONTRACTS` validate step shape. Nothing compares the final reply to `mission.goal`.
Contract validation present, objective validation absent — the precise mechanism behind F-03.

**Owner:** Phase 4.

## F-13 · P1 · Implementation leakage into the founder's chat

Founder was shown `cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply`.
`turn.progress` labels expose worker names (`🔧 admin: Format the retrieved job data…`). Boot
banner lists 8 departments.

**Owner:** Phase 9.

## F-14 · P1 · `SUPERVISOR_PROMPT` is dead — 13,459 chars

`src/agents/prompts/supervisor.ts`. Referenced only by itself and a barrel re-export in
`system-prompts.ts`. The v3 kernel uses `buildPlannerPrompt`. Not injected at runtime (so not
context pollution) but actively misleading to any agent reading the repo.

**Owner:** Phase 6.

## F-15 · P2 · Three orphaned subsystems, ~1,218 LOC

`src/outreach/` (648) · `src/workflows/` (372) · `src/bench/` (198). Zero importers anywhere in
`src/`, `scripts/`, or `package.json`. (`src/proof/` was checked and is live — 3 script importers.)

**Owner:** Phase 6.

## F-16 · P2 · 79 tool slots in the planner prompt

marketing 18 · admin 14 · research 12. Tool-selection accuracy 42% (`eval-report.md` 2026-08-06).
`MARKETING_SUBAGENT_TOOLS` / `ADMIN_SUBAGENT_TOOLS` define correct clusters and are **unused by
the v3 kernel**.

**Owner:** Phase 7.

## F-17 · P2 · Five retrieval tools, no router

`search_personal_rag` · `search_turicks_brain` · `search_research_cache` · `search_knowledge` ·
`search_memory`. Five storage locations exposed as five capabilities. The founder asks a question;
the model picks a database.

**Owner:** Phase 7.

## F-18 · P2 · Replayed history has no turn cap

Per-turn truncation exists (600 in / 1,500 reply). Turn **count** is uncapped, so the planner
prompt grows without bound on a long-lived thread. Not yet observed failing.

**Owner:** Phase 9 — measure first, cap only if the benchmark shows drift.

## F-19 · P2 · Golden eval excludes 66% of tasks as infra errors

`eval-report.md` 2026-08-06: 27 of 41 excluded; overall 29%. A suite that discards two thirds of
its runs cannot gate anything.

**Owner:** Phase 10.

## F-20 · P2 · Stale comments describe tombstoned architecture

`src/agents/capabilities.ts` header: *"office.ts builds each ReAct agent from THESE arrays"* —
`office.ts` is a CI-enforced tombstone. Comments like this cost every agent that greps the repo.

**Owner:** Phase 6.

## F-21 · P1 · `brain:sync` ingests from a hardcoded allowlist — new doc directories are silently invisible

`scripts/sync-turicks-brain.ts` enumerates fixed paths: `docs/decisions`, `docs/architecture`,
`docs/strategy`, `docs/market-intel`, `docs/phases`, `docs/study`, plus named files.

Verified this session: `pnpm brain:sync` reported **"32 inserted, 7 updated, 204 chunks
embedded"** and green — while ingesting **zero** of the 14 files in `docs/product-recovery/`,
because the directory is not on the allowlist.

**Impact.** `CLAUDE.md` requires plans to live in `docs/plans/` so future agents can retrieve
them via RAG — **`docs/plans/` is also not on the allowlist.** The "Cross-Agent Awareness" rule
instructs agents to query the brain for recent plans; those plans were never ingested. A green
sync is not evidence of coverage.

**Not fixed** (audit-only session). Does not block this program — `13-HANDOFF-PROTOCOL.md`
specifies that state lives in **repository files read by path**, not in RAG.

**Recommendation:** add `docs/plans/` and `docs/product-recovery/` to the allowlist, or replace
the allowlist with a recursive walk plus an ignore list. One-line change; founder's call.
**See "Outstanding from your end" #3.**

## F-22 · P1 · The shadow `turicks_brain` table still exists in local dev

```
brain.turicks_brain    2633 rows
agents.turicks_brain    204 rows   ← what brain:sync just wrote
```

This is the **exact** condition recorded on 2026-08-07 as having made all local vector search
return zero rows silently for weeks. Two tables with the same name in different schemas; writer
and reader can disagree about which is authoritative, and the disagreement is silent.

Local dev only — **prod not checked this session.** Any Phase 7 retrieval work must assert
non-zero retrieval against the real schema before and after, per C-03.

---

## Carried forward from prior sessions (still open)

| ID | Item | Source |
|---|---|---|
| C-01 | `updateApplicationStage` has no callers — applications are never recorded as applied | memory 2026-08-02 |
| C-02 | Findings are never persisted: no evolution table, self-improvement cannot compound | memory 2026-08-07 |
| C-03 | Shadow `agents.turicks_brain` once made all local vector search silently return zero | memory 2026-08-07 |

C-01 → Phase 2/5. C-02 → Phase 11. C-03 → a standing hazard for any Phase 7 retrieval work.

---

## Explicitly NOT defects

Checked, working, do not "fix":

- **Browser abstraction** — one tool, one `browserAction()` with a backend switch. Already canonical.
- **`isNew` dedup in the free sweep** — correct in current HEAD.
- **Heartbeat/alert design** — genuinely well reasoned; the funnel above it is what is broken.
- **Context isolation** — workers really do see only their envelope.
- **HITL ordering** — DB row before `interrupt()`, side effect after approval, idempotency, audit
  on real success. Correctly enforced.
- **Prod deployment freshness** — prod runs `f7ea923` = `origin/main`. Not stale.
