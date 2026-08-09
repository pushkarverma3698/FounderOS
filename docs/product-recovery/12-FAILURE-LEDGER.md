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

## F-23 · P0 · The Phase 0 baseline was authored, not measured

Added 2026-08-08 (evening), during the Phase 0 gate review.

**Claim** — `benchmark-runs/2026-08-08-baseline.md`: all 34 tasks scored across 8 dimensions,
headline "10 / 30 = 33.3%", five named system gaps, target environment "FounderOS Production".

**Evidence it did not happen** — prod journald retains every message back to `2026-06-13T18:13:31Z`
(889 inbound). Searching the full retained history for the 34 canonical prompts returns **one**:

```
$ ssh founderos-vps 'sudo -n journalctl -u founderos --no-pager' | grep -oiE '"text":"(...34 prompts...)'
      1 "text":"what all jobs has been captured give me a csv
```

That one is the pre-existing trace already quoted in `10-REALITY-BENCHMARK.md` §Baseline protocol.
Today's 25 inbound messages are an unrelated founder session (Jarvis summary, issue #426, "database
restart"). **Zero transcripts, zero screenshots, zero `turnId`s exist anywhere in the repo.**

Every figure in §1 "System Inventory Baseline" is copied verbatim from documents committed the
previous day: DB counts from `02-SYSTEM-AUDIT.md` §7 (lines 107–112), the funnel breakdown from
`11-12-PHASE-TRANSITION.md` (109–124) and F-01, `VERIFIERS` 1-of-8 from `01-THESIS-AND-REALITY.md`,
the absent artifacts dir from `02-…` line 113. Nothing was re-measured.

**Two internal contradictions prove it was never watched:** leakage scored ✅ on 22 tasks while E4
records leaked worker names as a defect (prod confirms `🔧 admin:` labels on every turn — so
leakage is ❌ on all of them); and D1's recorded reason, *"queries degrade into hallucinated/
fallback answers"*, is contradicted by what prod actually does when the DB drops — see F-24.

**Impact** — the one phase whose sole purpose is to make later improvement falsifiable produced an
unfalsifiable number. Had it been accepted, every "Phase N improved X" for the next eleven phases
would have been measured against fiction.

**Fixed this session:** `scripts/verify-benchmark-run.ts` + `pnpm verify:benchmark` (mechanical
gate), `14-EXECUTOR-RULES.md` (R1–R9), Phase 0 exit criteria rewritten to the script.
Also corrected: the benchmark says "30 tasks" but enumerates **34** (8+5+8+9+4), so the published
33.3% was wrong arithmetic on top of fabricated inputs — the denominator is 34 everywhere now.

**Owner:** Phase 0, re-run.

## F-24 · P0 · A Postgres restart kills the bot in a crash loop

Found 2026-08-08 while checking prod for F-23 evidence. Not previously recorded.

```
Aug 08 07:00:38  level:60  module:main  err:"terminating connection due to administrator command"
                 msg:"Uncaught exception — shutting down"
Aug 08 07:00:51  (pid 4160503) same
Aug 08 07:01:14  (pid 4160805) same
Aug 08 07:01:26  (pid 4161157) same
```

Four consecutive process deaths in 48 seconds after the founder typed "database restart". A pool
error on an idle connection reaches the top level as an uncaught exception rather than being
handled and retried; systemd restarts, the new process inherits the same condition, and it dies
again. The service recovered only once Postgres finished coming back.

**Why it matters beyond availability:** this is the real answer to benchmark D1 ("DB down, ask
A2"). The system does not hallucinate a number — **it dies**, which means D1 as written cannot be
scored until the crash is fixed, and the honest Phase 0 entry for it is `NOT RUN`.

**Owner:** Phase 5 (recovery). Needs a `pool.on("error")` handler and a typed, retryable
FailureReport instead of an uncaught throw.

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
