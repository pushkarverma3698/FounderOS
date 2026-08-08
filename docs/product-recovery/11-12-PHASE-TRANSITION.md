# FounderOS — 12-Phase Transition Program

**This document is the contract.** Sonnet implements a phase; Antigravity validates it. Neither
redesigns the architecture. A phase that needs a design change stops and says so.

---

## Ordering rationale — and where it departs from the thesis

The strategy documents proposed: *align → inventory → simplify → instructions → context →
capability → execution → verification → E2E → benchmark → learning → productize.*

**Two changes, both forced by evidence:**

1. **Outcomes before cleanup.** The thesis puts simplification at Phase 3. But the job lane
   screens 0 of 20,550 candidates per sweep and the founder cannot get a CSV of his own data.
   Deleting dead code first would produce a tidier repo that still delivers nothing. Phases 1–4
   restore outcomes; 5–8 remove complexity.
2. **The benchmark comes second, not tenth.** You cannot claim a phase improved anything without
   a baseline. Phase 0 establishes it.

Simplification is **not** deprioritised — it is sequenced after we can measure whether it helped.

```
0  BASELINE          ── measure before touching anything
1  FUNNEL VISIBILITY ── make the job lane's failure legible, then fix it
2  STRUCTURED STATE  ── Tier 0: the system can read its own data
3  ARTIFACT PATH     ── create → validate → deliver → confirm
4  VERIFICATION      ── fill the empty seam; kill false success
   ───────────────── outcomes restored ─────────────────
5  RECOVERY
6  DEAD CODE REMOVAL
7  CHOICE REDUCTION
8  INSTRUCTION + CI
   ───────────────── complexity removed ─────────────────
9  FOUNDER EXPERIENCE
10 ADVERSARIAL HARDENING
11 LEARNING LOOP
12 CONVERGENCE
```

---
---

# PHASE 0 — Baseline

**1. Mission.** Run the Reality Benchmark against prod, unchanged, and record every score.

**2. Why.** Every later claim of improvement is unfalsifiable without this. It also costs nothing
and cannot break anything.

**3. Evidence.** `eval-report.md` reports 29% overall while excluding 27/41 tasks as infra errors —
we currently have no number that means anything about founder outcomes.

**4. Current state.** No objective-completion metric exists anywhere.

**5. Problems.** Improvement is asserted, not measured. This is the mechanism behind "shipped
green, changed nothing."

**6. Root cause.** All measurement is at contract level (did the step match its schema), none at
objective level.

**7. Target state.** A committed baseline file with 34 tasks × 8 dimensions.

**8. Changes.**
- Create `docs/product-recovery/benchmark-runs/` .
- Antigravity executes all 34 tasks from `10-REALITY-BENCHMARK.md` through real Telegram, in the
  evidence format of `14-EXECUTOR-RULES.md` § Benchmark evidence format.
- Export the raw prod journal covering the run window to `<run>.md.evidence.jsonl`. Every
  `turnId` in the scorecard must appear in it.
- Capture prod funnel snapshot: 24h of `free-ingest` log lines + the four DB counts in `02-…` §7.
  Re-measure them — the figures in `02-…` are from 2026-08-08 and must not be recopied (R3).

**9. Preserve.** Everything. **No code changes in this phase.**

**10. Remove.** Nothing.

**11. Tests.** None.

**12. Reality tests.** The benchmark itself.

**13. Exit criteria.**

```bash
pnpm verify:benchmark docs/product-recovery/benchmark-runs/<date>-baseline.md
```

exits 0, **and** the run file plus its `.evidence.jsonl` are committed. The script requires, per
task: the canonical prompt, an ISO-8601 instant, a unique `turnId` that appears in a prod journald
export the runner did not author, a verbatim reply, and dimension scores that sum to the stated
total. A task that could not be run is `NOT RUN — <reason>`; that is honest and is not counted
against the run.

Group A1 is expected at 3/8 — if it scores higher, re-audit before proceeding.

> **First attempt REJECTED, 2026-08-08.** A complete 34-task scorecard was produced by reading the
> repository instead of using the product: 33 of the 34 prompts had never been sent to the bot in
> prod's entire retained history (back to 2026-06-13), zero transcripts existed, and the whole
> inventory section was copied out of `02-SYSTEM-AUDIT.md`. The rejected file is kept at
> `benchmark-runs/2026-08-08-baseline.md`, stamped, as the specimen of this failure mode.
> **Read `14-EXECUTOR-RULES.md` before re-running.**

**14. Dependencies.** None.

**15. Risks.** Side-effecting tasks (B3, C1, C3, C7) hit real systems — run with the founder
present or against staging. Do not skip them; they are the tasks that matter most.

---

# PHASE 1 — Job funnel visibility, then repair

**1. Mission.** Make the free lane's 100% drop rate visible, then fix the cause the numbers name.

**2. Why.** This is the binding constraint on the founder's actual goal. The lane has produced
**2 applications in its lifetime** while reporting 285 boards and 20,550 candidates every 30
minutes. Everything else in this program is downstream of a pipeline that produces nothing.

**3. Evidence.**
```
Aug 08 09:30:19  jobhunt:free-ingest  boards=285  seen=20554  screened=0  failed=0
… identical on ~144 consecutive sweeps since Aug 05
```
- `job_applications`: 39 rows / 8 days; `free-ats-ingest`: 5 rows
- `applied_at is not null`: **2**
- prod trace 05:31:57Z — `cv_gaps`: *"built from 1 passing posting(s) — TOO SMALL TO ACT ON"*

**ROOT CAUSE — measured 2026-08-08, `scripts/diagnose-free-funnel.ts` against all 285 live boards:**

```
18,888 fetched
  ├─ undated          18   0.1%
  ├─ stale >6h    18,865  99.9%   ← the gate
  ├─ off-track         5   0.0%   (all five 0-6h survivors died here)
  ├─ off-market        0   0.0%
  └─ KEPT              0   0.0%
```

Age distribution of the boards' own inventory: `0-6h: 5` · `6-24h: 272` · `1-3d: 641` ·
`3-7d: 796` · `7-30d: 4,277` · `>30d: 12,879`.

`FREE_LANE_MAX_AGE_HOURS = 6`. Its stated premise is *"older than 6h ⇒ seen in an earlier
sweep"* — and that premise was **never true**. The gate rejected the back catalogue before
`keepUnseen` could record it, so nothing older than 6h ever became "seen". **A bootstrap
deadlock, not a threshold that is merely tight.** The lane can only ever catch a posting
published inside a 6-hour window, and the boards surface 5 such postings out of 18,888.

Measured supply at wider windows (same script, `--age`): **7d → 34** · **30d → 132**.

> The instrumentation work below is still required — it is what stops this recurring and what
> proves the fix on the metered lane too. But **do not re-derive the root cause; it is above.**

**4. Current state.** `runFreeIngest` (`src/tools/jobhunt/free-ingest.ts:194`):
`sweepBoards` → `filterCandidates` → `keepUnseen` → `hydrateDescriptions` → `screenBatch`.
`filterCandidates` returns per-reason drop counts in `notes[]`. On a quiet sweep those notes are
**discarded** — only the new-roles alert path renders them.

**5. Problems.**
- P1a 100% of candidates dropped before screening, for ≥3 days, silently.
- P1b The diagnostic data is computed and thrown away.
- P1c A closed funnel and an empty market are indistinguishable from outside — the exact ambiguity
  `sweep-heartbeat.ts` was written to prevent, recurring one layer deeper.

**6. Root causes.**
- Instrumentation is attached to the **alert path**, not to the **sweep**. No alert → no numbers.
- The funnel has no assertion that a healthy sweep must pass a non-zero fraction.

**7. Target state.** Every sweep logs a structured per-stage funnel. The alive-ping carries it.
A sweep dropping 100% for N consecutive runs raises a distinct alarm. Then: the identified cause
is fixed and new rows appear.

**8. Changes.**
- `free-ingest.ts`: return a typed `funnel { seen, undated, stale, offTrack, offMarket, known, bodyless, screened }`. The counts already exist — stop discarding them.
- Log the funnel on **every** sweep at info level, and persist it to the existing
  `job_ingest_runs` table.
- `sweep-heartbeat.ts` `formatAlivePing`: include the top drop reason and its count.
- Add a `ZERO_PASS_STREAK` threshold (suggest 6 sweeps = 3h): emit a distinct
  *"the funnel is closed at stage X"* alert. **Not** a generic warning.
- **Fix the freshness gate.** Its premise is false (see Evidence). Two parts, and the second is
  the one that actually matters:
  - Replace the 6h cutoff with a window wide enough to admit the standing inventory once
    (30d → 132 candidates; 7d → 34). **Founder decides the number** — it is a
    quality-vs-volume call, not an engineering one.
  - **Make `keepUnseen` the dedup mechanism, not the age gate.** Age should bound *relevance*,
    never stand in for *"have I seen this"*. Conflating the two is what created the deadlock, and
    a wider window alone leaves the same bug one number further out.
- Re-run the metered sweep manually once to confirm the fix on the paid lane too.
- Watch the first sweep after the change: ~132 rows will hit screening at once. That is the
  back catalogue draining, and it happens exactly once.

**9. Preserve.** The `isNew` dedup logic, the heartbeat interval design, the zero-LLM property,
the "a total failure still sends" guarantee. All correct.

**10. Remove.** Nothing.

**11. Tests.**
- `filterCandidates` returns exact counts per drop reason (table-driven).
- `runFreeIngest` returns a funnel summing to `seen`.
- Zero-pass streak alerts at N and not at N−1.
- Regression: a fixture reproducing the live 100%-drop condition, asserting the funnel names the
  right stage. **Write this before the fix.**

**12. Reality tests.** B1, B2. Founder asks *"why did I get nothing today"* → per-stage counts,
not "no jobs matched".

**13. Exit criteria.**
- 24h of prod logs show a per-stage funnel on every sweep.
- The dominant drop stage is **named with a number**, not hypothesised.
- After the fix, ≥1 new row from `free-ats-ingest` in 48h **or** an evidenced statement that the
  market genuinely has none, with the funnel proving it.

**14. Dependencies.** Phase 0.

**15. Risks.**
- Fixing the filter may flood the founder with low-quality roles. **Mitigation:** the funnel ships
  and runs for 24h *before* any threshold is loosened.
- Tempting to loosen thresholds to "get numbers up" — that manufactures applications that cannot
  succeed. `CLAUDE.md` #26 names this exact anti-pattern. **The fix must be a correctness fix.**

---

# PHASE 2 — Structured state (Tier 0)

**1. Mission.** Give the system the ability to read its own operational data.

**2. Why.** Highest-leverage missing capability. Every "what is the state of X" question fails on
it, and each failure degrades into a plausible wrong answer rather than an error.

**3. Evidence.** Prod turn `a194c5e5`: planner correctly asked jobhunt to "list all jobs currently
captured"; no such tool exists; the worker substituted `job_brief` and returned a ranked prose
brief. 39 rows exist; ~3 were named.

**4. Current state.** Tiers 1–3 of the memory hierarchy exist (5 retrieval tools). **Tier 0 —
deterministic structured state — does not exist.** Data is in well-designed Postgres tables no
worker can query.

**5. Problems.**
- P2a No generic read of `job_applications` (39 rows, 40 columns, unreachable).
- P2b Same for scheduled tasks, reminders, costs, approvals, action log.
- P2c A missing capability degrades silently into a nearby one.

**6. Root cause.** Tools were built per *workflow* (ingest, screen, brief) rather than per
*question*. No workflow tool answers "show me the data".

**7. Target state.** A worker asked a state question calls one read-only tool that returns
**structured records with a count**, from the authoritative table.

**8. Changes.**
- New tool `job_state` (jobhunt + admin), read-only, no HITL. Filters: `stage`, `section`,
  `source`, `applied`, `since`, `limit`. Returns `{ count, total, rows[] }` — **`total` always the
  unfiltered count**, so completeness is checkable.
- New tool `ops_state` (admin), read-only. Scopes: `scheduled_tasks`, `reminders`,
  `hitl_approvals`, `action_log`, `costs`. Same `{ count, total, rows[] }` shape.
- Add to `jobhunt.ts` / `admin.ts` prompts: **state questions use `*_state`; `job_brief` is for
  ranked recommendations only.** One sentence each.
- Reuse existing query helpers in `src/db/apply-queries.ts` / `queries.ts`. **Write no new SQL
  layer.**

**9. Preserve.** `job_brief` and `review_screened` — both have real, distinct jobs.
Read-only means read-only: no writes, no HITL, no side effects.

**10. Remove.** Nothing.

**11. Tests.**
- `job_state` with no filter returns all 39 fixture rows and `total === 39`.
- Every filter combination; empty result returns `count: 0`, not an error.
- Architecture test: state tools declare no side effects and are absent from `HITL_GATED_TOOLS`.

**12. Reality tests.** A2, A3, A4, A5, A7, A8.

**13. Exit criteria.** A2/A3/A4 score 8/8. A7 returns rejected rows **each with its gate reason**
(`gate_json` already stores them).

**14. Dependencies.** Phase 0. (Independent of Phase 1 — can run in parallel.)

**15. Risks.**
- Adds 2 tools to a 79-slot catalog. Accepted: Phase 7 removes ~10. Net negative.
- Returning 39 rows of 40 columns will blow the context. **Cap columns to a curated set; make the
  full set opt-in per query.**

---

# PHASE 3 — The artifact path

**1. Mission.** One working chain: create a file → validate it → deliver it → confirm receipt.

**2. Why.** Every "give me a file" request currently fails. The founder receives inline text
labelled as a deliverable.

**3. Evidence.** `write_artifact` is admin-only, hardcoded `.md`, writes to `./artifacts` →
`/opt/founderos/artifacts`, **which does not exist on prod**. `send_file` is personal-only and
path-guarded to `/home/founderos`. The roots do not intersect.

**4. Current state.** Two tools that cannot compose, on different workers, with disjoint
filesystem roots and a wrong extension.

**5. Problems.**
- P3a `write_artifact` cannot produce `.csv`.
- P3b Its output directory does not exist in production.
- P3c It returns `✅` without `stat`-ing the file.
- P3d Delivery lives on a different worker behind a guard that excludes the artifact root.

**6. Root cause.** The two tools were built for different eras and never composed. Nobody ran the
end-to-end case in production.

**7. Target state.** Any worker producing a deliverable writes it to one artifact root, gets back
a verified path + size + row count, and delivery attaches it to Telegram and confirms.

**8. Changes.**
- Single `ARTIFACT_ROOT` from config, defaulting **inside `personalRoot()`** so the path guard
  admits it. Create on boot.
- `write_artifact`: accept `format: "md" | "csv" | "json" | "txt"`; `stat` after write; return
  `{ path, bytes, rows? }`. **Fail loudly if bytes === 0.**
- Add `deliver_artifact` to admin + jobhunt: takes an artifact path, validates it is under
  `ARTIFACT_ROOT`, sends via `sendDocument`, returns the Telegram message id. HITL-gated
  (outbound), reusing the existing gate.
- Boot check in `infra/boot-validate.ts`: `ARTIFACT_ROOT` exists and is writable. Fail loud.

**9. Preserve.** The path guard and its denylist — **do not widen it**. Move the artifact root
inside it instead. `send_file` keeps its current behaviour for arbitrary founder files.

**10. Remove.** Nothing.

**11. Tests.**
- Round trip: write CSV → `stat` → deliver → message id.
- Zero-byte write fails loudly.
- Path traversal / outside-root rejected.
- Boot validation fails when the root is unwritable.

**12. Reality tests.** **A1** (the canonical case), A6.

**13. Exit criteria.** A1 scores 8/8: all 39 rows, valid CSV **attached as a file**, reply states
"39 records". Verified on prod, in Telegram, by Antigravity.

**14. Dependencies.** Phase 2 (needs `job_state` to have rows to export).

**15. Risks.** HITL on every artifact could be annoying. **Mitigation:** gate delivery only, not
creation — one approval per file, matching the existing `send_file` contract.

---

# PHASE 4 — Verification and the end of false success

**1. Mission.** Make "done" mean the objective happened. Fill the verification seam that exists
and is empty.

**2. Why.** The single most damaging behaviour in the system. A wrong answer is recoverable; a
wrong answer labelled "Mission complete" destroys trust in every correct one.

**3. Evidence.** `src/kernel/verify.ts` `VERIFIERS` has exactly one key (`comms`). Seven workers
unverified. Prod turn `a194c5e5` replied "Mission complete" having delivered 3 of 39 rows as chat
text.

**4. Current state.** `verifyStepResult` is correctly wired into `worker.ts` and returns a typed
`stage: "validation"` failure. **The seam is built. The map is empty.** No mission-level check
exists at all.

**5. Problems.**
- P4a 7 of 8 workers unverified.
- P4b Tools report actions, never observations.
- P4c No check that the reply satisfies `mission.goal`.
- P4d `writeTaskOutcome` has zero callers — no outcome is ever recorded.

**6. Root cause.** Verification was designed at **contract** level (does the step match its
schema) and never at **objective** level (did the founder get what he asked for).

**7. Target state.** A step cannot pass verification without evidence, and a mission cannot report
complete with unmet goals.

**8. Changes.**
- Populate `VERIFIERS` for all 8 workers — see `09-VERIFICATION-RECOVERY.md` T1. Pure functions.
- Add optional `observed: { kind, evidence }` to the tool result envelope. Populate for
  `write_artifact`, `deliver_artifact`, `github_write`, `browser`, `claude_code`, `send_email`.
  Executor-populated, **never model-populated**.
- Add pure `missionSatisfied(goal, steps, results)`. On unmet, the synthesizer must produce a
  partial-completion reply naming what is blocked. Never "complete".
- Call `writeTaskOutcome` from the terminal node.

**9. Preserve.** `ToolReceipt`, `validateStepResult`, `OUTPUT_CONTRACTS`, `FailureReport`, the
whole HITL ordering. **This substrate is why Phase 4 is cheap — do not refactor it.**

**10. Remove.** Nothing.

**11. Tests.**
- Per-worker verifier: passing case + failing case each.
- Verifier failure produces `stage: "validation"` with a component name.
- `missionSatisfied` unit table, including the exact CSV scenario (3 of 39 rows → unmet).
- Kernel E2E: a step claiming success with no receipt is rejected.

**12. Reality tests.** All of Group D. **D1 (DB down → never invents a number) is the gate.**

**13. Exit criteria.** Group D ≥ 7/9 at 8/8, **truthfulness = 100% across all 34 tasks**.
No task in the suite receives a success claim for an objective that did not complete.

**14. Dependencies.** Phases 2, 3.

**15. Risks.**
- Over-strict verifiers turn working flows into failures. **Mitigation:** verifiers assert
  *evidence present*, not *result good*. A verifier must never make a quality judgement.
- Watch the retry loop: a verification failure is `retryable: true` and could loop. Cap it.

---

# PHASE 5 — Recovery and objective ownership

**1. Mission.** When a mission partially fails, keep what succeeded and say precisely what is
blocked.

**2. Why.** Phase 4 makes failures honest. Phase 5 makes them useful. Without it, honesty
increases the founder's workload.

**3. Evidence.** `supervisor.ts` gives one blind retry. A 3-step plan failing at step 3 fails
whole. `src/gateway/mission-resume.ts` exists — **wiring unverified**.

**4. Current state.** Retry + failure-lesson lookup (2 lessons in prod). No partial resume, no
alternate path, no "here is how far I got".

**5. Problems.** P5a all-or-nothing missions · P5b no resume after founder input ·
P5c `mission-resume.ts` status unknown.

**6. Root cause.** Mission state is a cursor over a plan, not a ledger of what is done.

**7. Target state.** A failed mission reports completed steps with their receipts, names the
blocked step and why, and offers the one next action.

**8. Changes.**
- **First: read `mission-resume.ts` and determine whether it is wired.** If yes, extend. If no,
  decide wire-or-delete. Do not build alongside it.
- Persist completed step receipts so a resumed mission does not redo side effects (idempotency
  keys already exist — reuse them).
- Partial-failure reply shape: what completed (with evidence), what is blocked (with the
  component), one suggested action.

**9. Preserve.** One-retry semantics. The lesson store. Idempotency. Never auto-retry a
side-effecting step without a fresh idempotency check.

**10. Remove.** `mission-resume.ts` **only if** proven unwired.

**11. Tests.** 3-step plan failing at step 3 → steps 1–2 receipts retained. Resume does not
re-execute a completed side effect. Non-retryable failure never retries.

**12. Reality tests.** D6 (kill mid-HITL, resume), C6, C7.

**13. Exit criteria.** D6 passes. A deliberately failed 3-step mission reports 2 successes with
receipts and names the blocked component.

**14. Dependencies.** Phase 4.

**15. Risks.** Resume + idempotency is where duplicate side effects live. **Every resume path
needs an idempotency test before it ships.**

---

# PHASE 6 — Dead code removal

**1. Mission.** Delete what nothing calls.

**2. Why.** ~1,306 LOC and 13.5k chars of prompt exist that no execution path reaches. They cost
every agent that greps the repo, and they are how "wired to nothing" keeps recurring.

**3. Evidence.** Zero-importer analysis (`02-SYSTEM-AUDIT.md` §1–2).

**4. Current state.**

| Target | LOC/size | Importers |
|---|---:|---|
| `src/outreach/` | 648 | 0 |
| `src/workflows/` | 372 | 0 |
| `src/bench/` | 198 | 0 |
| `src/kernel/context-composer.ts` | 88 | tests only |
| `SUPERVISOR_PROMPT` + `buildSupervisorPrompt` | 13,459 chars | self + barrel |
| `agents.agent_results` table | 0 rows | nothing |

**5. Problems.** Dead code reads as live to every fresh agent; four separate build-and-never-wire
instances confirmed.

**6. Root cause.** No mechanism fails CI when a subsystem loses its last importer.

**7. Target state.** Every directory in `src/` has ≥1 importer or an explicit script entrypoint,
and CI enforces it.

**8. Changes.**
- Verify each target with a grep across `src/`, `scripts/`, `tests/`, and `package.json` scripts.
- **`context-composer.ts` needs a decision, not a default.** Either wire it in Phase 7 or delete
  it now. Recommendation: **delete** — Phase 7's needs are simpler than what it implements, and a
  second unwired context layer is exactly the failure this program exists to end.
- Delete `SUPERVISOR_PROMPT` / `buildSupervisorPrompt` and their re-export. Update the tests that
  assert on routing keywords.
- Add `orphan-subsystem` ratchet to `scripts/verify-architecture.ts`, baseline 0.
- One commit per subsystem, each independently revertable.

**9. Preserve.** `src/proof/` — **verified live**, imported by `scripts/proof-scoreboard.ts`,
`scripts/proof-cost-ledger.ts`, `scripts/export-case-study.ts`. `src/evolution/` is thin but
**live** (`scheduler.ts` calls `runSelfAuditSweep`) — keep it.

**10. Remove.** The table above, minus anything the verification step disproves.

**11. Tests.** `pnpm gate` green after each deletion. New ratchet fails when a fixture orphan dir
is added.

**12. Reality tests.** None — but re-run the full benchmark to confirm no regression.

**13. Exit criteria.** ~1,306 LOC removed, `pnpm gate` green, `orphan-subsystem: 0` in the
baseline, benchmark unchanged from post-Phase-5.

**14. Dependencies.** Phase 5 (do not delete during active repair).

**15. Risks.** Deleting something reached only via dynamic import. **Mitigation:** grep for the
bare module name, not just import statements. All deletions are git-recoverable.

---

# PHASE 7 — Choice reduction

**1. Mission.** Cut the model's decision surface without removing a single capability.

**2. Why.** 79 tool slots in every planner prompt; tool selection scores 42%. Every extra
plausible path is a chance to pick wrong.

**3. Evidence.** marketing 18 tools / 13,138-char prompt · research 12 · admin 14 with a
2,039-char prompt · five retrieval tools with no router.

**4. Current state.** `MARKETING_SUBAGENT_TOOLS` and `ADMIN_SUBAGENT_TOOLS` already define correct
clusters and **are not used by the v3 kernel**.

**5. Problems.** P7a marketing is the worst decision surface · P7b five memory tools, model picks
· P7c four research tools differing only in cost/depth, with no cost signal · P7d five
code-execution tools with overlapping descriptions.

**6. Root cause.** Tools were added per integration. Nothing ever collapsed the *presentation*.

**7. Target state.** No worker exposes more than ~12 tools. One `recall`. One `research`.
Code-execution descriptions state blast radius.

**8. Changes.**
- **Split marketing** into `marketing` (social/brand) and `creative` (image/video), using the
  existing cluster definitions. Split the prompt with it. Prefer splitting the worker over
  building a sub-agent router — no new abstraction.
- **Collapse retrieval to one `recall(query, scope?)`.** All five backends retained; code selects
  by worker + scope. Keep old names as deprecated aliases for one release.
- **Collapse research to `research(query, depth: quick|deep|crawl)`.** All four executors
  retained.
- **Sharpen, do not merge, the five code-execution tools** — each description states where it runs
  and what it can break.
- Add ratchet: max tools per worker, baseline at the new counts.

**9. Preserve.** **Every executor.** This phase changes names the model sees, not power it has.
`browser` stays exactly as it is — already canonical (`04-DUPLICATION-AUDIT.md` D1).

**10. Remove.** ~10 tool *names* from the model's view. Zero tools from the codebase.

**11. Tests.** Each collapsed tool routes to the right backend for every scope/depth. Deprecated
aliases still work. Wiring check passes for the new worker. Per-worker tool-count ratchet.

**12. Reality tests.** Full benchmark. **Compare tool-selection accuracy against the Phase 0
baseline — if it does not improve, revert the collapse and say so.**

**13. Exit criteria.** Planner catalog ≤ 60 slots, no worker > 12 tools, benchmark overall ≥ 60%
at 8/8, and **no capability lost** (every Phase-0-passing task still passes).

**14. Dependencies.** Phase 6.

**15. Risks.**
- A collapse can hide a capability the model used to find. **Mitigation:** the exit criterion
  explicitly requires no regression on previously-passing tasks.
- Splitting marketing changes routing. Golden eval will show it — expect churn, budget for it.

---

# PHASE 8 — Instructions and CI

**1. Mission.** Shrink the development instruction surface and convert the rules worth keeping
into mechanisms.

**2. Why.** `CLAUDE.md` #27 measured it: CI rules drifted zero times in a month, markdown rules
three times in a day. Adding instructions is the lever that does not work.

**3. Evidence.** 1,342 root instruction lines + 22,403 doc lines. Rules #28–#33 are each
self-labelled *"Enforced by: nothing."*

**4. Current state.** 12 root `.md` files. 5 CI ratchets. No size gate on the deep-ideate rule.

**5. Problems.** P8a architecture narrative sits in always-loaded instructions · P8b rules #25/#26
apply full ceremony to two-line fixes · P8c six rules with no mechanism.

**6. Root cause.** New rules are written where writing is cheap, not where enforcement lives.

**7. Target state.** `CLAUDE.md` + `AGENTS.md` ≤ 450 lines combined, holding only always-true
behaviour. Everything else in `docs/`, retrieved on demand. Four new CI ratchets.

**8. Changes.**
- Move `JARVIS-ARCHITECTURE.md`, `ZERO-BASE-AUDIT.md`, `ARCHITECTURE_LEDGER.md`,
  `agent-rules.md` → `docs/architecture/`. Leave one-line pointers.
- Move the file map, commands, model policy, VPS block, and History section out of `CLAUDE.md`.
- **Add the scope gate to rules #25/#26** — exact wording in `05-INSTRUCTION-AUDIT.md`.
- Add ratchets: `orphan-subsystem` (Phase 6), `verifier-coverage` (Phase 4),
  `tools-per-worker` (Phase 7), `kernel-dead-export`.
- Update `AGENTS.md` / `GEMINI.md` to point at `docs/product-recovery/` as the operating contract.

**9. Preserve.** Precedence ladder · HITL ordering · determinism · #24 evidence-over-assertion ·
#27 · #29 review-not-delegable. These are earned and cheap.

**10. Remove.** Nothing deleted. Content **relocates**.

**11. Tests.** `pnpm verify:arch` green with 9 ratchets. A fixture violating each new ratchet
fails CI.

**12. Reality tests.** None directly. Track whether subsequent phases ship faster.

**13. Exit criteria.** Root instruction lines ≤ 450 · root `.md` files ≤ 5 · 9 ratchets green ·
every remaining `CLAUDE.md` rule names its enforcement layer.

**14. Dependencies.** Phases 4, 6, 7 (their rules become the ratchets).

**15. Risks.** Moving a rule out of always-loaded context means an agent may miss it.
**Mitigation:** only move what is now CI-enforced or purely referential. Never move a safety rule
without a mechanism replacing it.

---

# PHASE 9 — Founder experience

**1. Mission.** Remove implementation leakage. Make replies read as an assistant's, not a
system's.

**2. Why.** The founder was handed
`cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply`. He should never
operate FounderOS to use FounderOS.

**3. Evidence.** Transcript: pasted shell command; `🚀 FounderOS is back online / 8 departments
ready: admin · research · comms · …`; `turn.progress` labels expose worker names
(`🔧 admin: Format the retrieved job data…`).

**4. Current state.** Progress labels, boot banners, and error text all surface internals.

**5. Problems.** P9a shell commands in chat · P9b department names as the vocabulary · P9c boot
banner reports infrastructure, not state · P9d duplicate/low-value notifications.

**6. Root cause.** Messages were written for the builder debugging the system.

**7. Target state.** No reply contains a shell command, worker name, tool name, or file path
unless the founder asked for it. The boot message states what is happening in his world.

**8. Changes.**
- Replace worker names in `turn.progress` with outcome language ("Pulling your job records…").
- Boot message → current state: pending approvals, ready applications, anything blocked. Not a
  department list.
- Anywhere a shell command is currently emitted: either execute it behind HITL or state the
  blocker in plain language. **Never paste a command.**
- Add a reply linter (pure function, unit-tested): reject replies matching shell-command,
  worker-name, or absolute-path patterns.

**9. Preserve.** Receipts blocks and failure reports — the founder must keep seeing evidence.
Evidence is not leakage; a Python invocation is.

**10. Remove.** The department-list banner.

**11. Tests.** Reply-linter table: leaked commands/paths/worker names rejected, legitimate
receipts and founder-requested paths allowed.

**12. Reality tests.** **E4 across all 34 tasks** — zero leaks. Plus E1, E2, E3.

**13. Exit criteria.** E4 = 0 leaks across the whole suite. E1/E2/E3 at 8/8. Linter wired into the
gateway reply path.

**14. Dependencies.** Phases 4, 5 (needs honest failure text to rewrite).

**15. Risks.** Over-aggressive linting could strip useful detail. **Mitigation:** allowlist
receipts, URLs, and founder-requested paths. Log rejections rather than silently rewriting.

---

# PHASE 10 — Adversarial hardening

**1. Mission.** Actively try to make FounderOS claim success when reality disagrees.

**2. Why.** Phase 4 built the mechanism. This phase proves it holds under failure — which is the
only condition where truthfulness matters.

**3. Evidence.** 178 HITL approvals and 73 action-log rows in prod; failure paths are exercised in
production but never deliberately.

**4. Current state.** Failure handling is unit-tested with fixtures. No systematic fault
injection.

**5. Problems.** P10a untested: DB outage, provider 500, malformed tool output, mid-HITL restart ·
P10b prompt injection defence exists in the planner prompt but is unverified end to end ·
P10c duplicate-request idempotency untested at the gateway.

**6. Root cause.** Failure modes are anticipated in comments, not exercised.

**7. Target state.** A repeatable fault-injection suite. Every injected fault produces a typed,
truthful failure — never a fabricated success.

**8. Changes.**
- Fault-injection harness: DB unreachable, provider 5xx/429, tool returns malformed JSON, tool
  times out, Telegram send fails, process killed mid-HITL.
- Run Group D against each.
- Live injection test for D8 (prompt injection in a fetched page).
- Every fault that produces a false success becomes a regression test **and** a failure-ledger
  entry.

**9. Preserve.** Fail-open catches with `// allow-failopen:` tags — they are deliberate and
documented. Verify each still degrades to *reduced function*, never to *false success*.

**10. Remove.** Any fail-open catch that can mask an objective failure. Re-baseline
`fail-open-catch` (currently 11) downward if any are removed.

**11. Tests.** One regression test per injected fault. `fail-open-catch` ratchet re-baselined.

**12. Reality tests.** Group D, all 9, all at 8/8.

**13. Exit criteria.** D = 9/9. Zero false successes under any injected fault. Fault harness
runnable via one command and wired into `pnpm gate` (mocked, $0).

**14. Dependencies.** Phases 4, 5, 9.

**15. Risks.** Fault injection against prod is dangerous. **Run against staging or a local
compose stack.** The one exception is D8, which needs a real fetch — use a controlled page.

---

# PHASE 11 — Learning loop

**1. Mission.** Make outcomes feed back, so the system gets better from use rather than from
sessions like this one.

**2. Why.** The self-improvement machinery exists and has nothing to learn from: 2 failure
lessons, 0 recorded task outcomes, 0 rows in `agent_results`.

**3. Evidence.** `writeTaskOutcome` zero callers · `agents.agent_results` 0 rows ·
`agents.failure_lessons` 2 rows · `runSelfAuditSweep` runs every 3 days with no outcome data to
read.

**4. Current state.** Lesson store wired and starved. Evolution subsystem wired and blind.

**5. Problems.** P11a no outcome is recorded, so nothing can compound · P11b the self-audit sweep
has no signal · P11c benchmark results live in markdown, not in the DB.

**6. Root cause.** The loop was built from the improvement end, not the measurement end.

**7. Target state.** Every mission writes an outcome row. The self-audit sweep reads real
completion rates. Benchmark runs are persisted and trended.

**8. Changes.**
- Call `writeTaskOutcome` from the terminal node (Phase 4 ships the call; this phase makes it
  useful): goal, worker path, tools used, verification result, mission satisfied y/n, duration,
  cost.
- Extend `runSelfAuditSweep` to read outcomes and report the **objective-completion rate**, not
  activity counts.
- Persist benchmark runs to a table; trend them.
- Feed verification failures into the lesson store — currently only retry failures reach it,
  which is why there are 2.

**9. Preserve.** Fail-open behaviour of the lesson store. Learning must never break a turn.

**10. Remove.** `agents.agent_results` if still unused after this phase — decide, don't leave it.

**11. Tests.** Terminal node writes exactly one outcome row per mission, on all paths (success,
failure, HITL-resume). Self-audit computes the right rate from fixtures.

**12. Reality tests.** After 7 days of real use, the self-audit reports a completion rate
consistent with a fresh benchmark run (±10%).

**13. Exit criteria.** ≥1 outcome row per prod mission for 7 consecutive days. Self-audit reports
a real completion rate. `failure_lessons` growing.

**14. Dependencies.** Phases 4, 10.

**15. Risks.** Outcome recording on every turn adds a write. Keep it fail-open and out of the
latency path.

---

# PHASE 12 — Convergence

**1. Mission.** Final anti-complexity pass, full benchmark, and honest publication of what
FounderOS does and does not do.

**2. Why.** Eleven phases of repair add incidental complexity. Every previous cleanup effort in
this repo skipped the pass afterwards.

**3. Evidence.** This program's own history: four separate build-and-never-wire subsystems were
each added during a repair.

**4. Current state.** (Assessed at phase start.)

**5. Problems.** Determined by measurement, not anticipated here.

**6. Root cause.** Repair adds; nothing subtracts unless scheduled.

**7. Target state.** Measurably simpler than Phase 0 on every axis, and measurably more reliable.

**8. Changes.**
- Re-run the zero-importer analysis. Delete what the repair introduced and left unwired.
- Re-measure and publish the scorecard:

| Metric | Phase 0 | Phase 12 |
|---|---|---|
| Objective completion (34 tasks, 8/8) | *baseline* | ≥ 85% |
| Truthfulness | *baseline* | **100%** |
| Planner catalog slots | 79 | ≤ 60 |
| Max tools per worker | 18 | ≤ 12 |
| Root instruction lines | 1,342 | ≤ 450 |
|  Orphan LOC | ~1,306 | 0 |
| Workers with a verifier | 1/8 | 8/8 |
| CI ratchets | 5 | ≥ 9 |
| Job funnel pass rate | **0%** | > 0, with per-stage numbers |
| Applications recorded | 2 lifetime | tracked weekly |

- Rewrite `docs/LIMITATIONS.md` from Phase 12 evidence — what still does not work, stated plainly.
- Update `README.md` to describe the system that exists.

**9. Preserve.** Everything that earned its place: the contract kernel, HITL ordering, receipts,
the CI ratchets, context isolation, the zero-LLM job lane.

**10. Remove.** Whatever the final orphan analysis names.

**11. Tests.** Full `pnpm gate` + fault harness + full benchmark, all in one session, output
shown.

**12. Reality tests.** All 30, run by Antigravity, transcripts committed.

**13. Exit criteria.** Every row of the scorecard met or explicitly missed with a reason.
`LIMITATIONS.md` rewritten from evidence. **No metric asserted without a command run in-session.**

**14. Dependencies.** All.

**15. Risks.** The temptation to declare victory. **Rule #24: a claim without a fresh command and
its output is "NOT VERIFIED — reason".**

---
---

## Dependency graph

```
0 ─┬─► 1 ──────────────┐
   └─► 2 ──► 3 ──► 4 ──┼─► 5 ──► 6 ──► 7 ──► 8 ──┐
                       └──────────► 9 ───────────┼─► 10 ──► 11 ──► 12
```

Phases 1 and 2 are independent and may run in parallel by different implementers.

## Phase completion rule

A phase is complete only when **all** hold:

1. Exit criteria met, each with a command run in-session and output shown
2. `pnpm gate` green
3. Reality tests run by Antigravity through Telegram, transcripts committed
4. The phase doc's status updated with real numbers
5. A handoff written per `13-HANDOFF-PROTOCOL.md`

**Not complete because:** code compiles · tests pass · architecture checks pass · an API returned
200.
