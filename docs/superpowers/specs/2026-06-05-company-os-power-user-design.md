# FounderOS → Company Operating System (Power-User) — Design & Go-Forward Plan

_Date: 2026-06-05 · Updated: 2026-06-05 · Status: Phase 0 ✅ + Phase 1 ✅ COMPLETE — Phase 2 next_

## The shift (locked from founder input)

FounderOS stops being a "personal AI assistant" and becomes **a system that operates a whole company**,
run **power-user style**. Three decisions are locked:

1. **Company-OS = Workflows / SOPs.** The defining capability: repeatable, multi-step company procedures
   ("weekly close", "new-client onboarding", "outbound cadence") that run as ONE command across departments
   — not one message = one task.
2. **Power-user = terse command grammar.** A dense, scriptable command surface (slash commands, macros,
   direct-to-department, batch). Driven like a CLI, not a chat.
3. **Autonomy = proactive + propose.** It runs scheduled ops and research on its own, drafts everything,
   and surfaces ready-to-approve actions. Sends always wait for ✅ (HITL is non-negotiable).

**Design principle (rule #17 triple-filter):** every new feature must be an *outcome*, a *2026 hiring
signal*, AND *mostly reuse*. We build a thin orchestration layer over the existing office + scheduler +
memory. We do NOT fork a parallel product.

## Where we are (the foundation this builds on)

8-department supervisor · crash-safe HITL · bounded-history (loop fix) · single-instance lock · budget
guard · path-guarded laptop ops + send_file · Postgres-first memory + MCP layer · deterministic eval ·
Telegram formatting engine · **435 tests green**. The base is production-grade; Phase 0 is complete.

**Phase 0 delivered (2026-06-05):**
- SUPERVISOR_PROMPT compressed ~40% (decision-table routing, same 8-dept coverage)
- `hitlGate()` helper in agent-tools.ts: single `interrupt()` owner, removes 10× duplication
- `commands.ts` (new): all Telegram command handlers extracted from telegram.ts (-231 lines)
- `pre-router.ts` (new): `preRoutePersonalVsEngineering` + `isOutreachRequest` pure functions + 19 tests
- Dead code deleted: `buildThreadId/buildThreadConfig/parseThreadId` from checkpointer.ts
- telegram.ts: 716 → 485 lines; agent-tools.ts: 644 → 615; system-prompts.ts: 377 → 336
- P0 prompt bugs fixed: stale send_file instruction, 7→8 depts, phantom write_file in engineering
- **PR #28** on branch `fix/telegram-reliability-wedged-interrupt` — all reliability + formatting + send_file + Phase 0 arch

---

## Phase 0 — Stabilize & clean ✅ COMPLETE

- ✅ **0.1 Prompt audit** — SUPERVISOR_PROMPT ~40% smaller (decision-table routing); PERSONAL_PROMPT deduped; P0 correctness bugs fixed; JOBHUNT updated to 8 depts + 400+ tests signal; regression guards all pass (435/435)
- ✅ **0.2 Pre-route pure functions** — `preRoutePersonalVsEngineering` + `isOutreachRequest` in `src/gateway/pre-router.ts`, 19 tests (not yet wired into telegram.ts — Phase 1 will use these as the workflow router)
- ✅ **0.3 Architecture cleanup** — `hitlGate()` helper; `commands.ts` extracted (-231 lines from telegram.ts); dead `buildThreadId/buildThreadConfig/parseThreadId` deleted; telegram.ts 716→485 lines
- ⏳ **0.4 Merge PR #28** — human approves + merges (all work is on branch `fix/telegram-reliability-wedged-interrupt`)

---

## Phase 1 — The Workflow / SOP Engine ✅ COMPLETE (the heart of "runs a company")

**Concept.** A *workflow* is a named, parameterized, ordered list of *steps*. Each step is a
natural-language task routed through the EXISTING office (so it inherits routing, tools, HITL,
idempotency, budget, memory). Step output chains into the next step's context.

```
Workflow "onboarding" (param: {company})
  1. prospecting → "Score {company} against Turicks ICP"
  2. research    → "Find {company}'s tech stack and 2 pain points"
  3. comms       → "Draft a welcome email to {company} referencing step 2"   [HITL]
  4. engineering → "Create a private GitHub repo turicks-{company}"           [HITL]
  5. supervisor  → record_event "Onboarded {company}"                          [HITL]
```

**Design (reuse-first, minimal net-new):**
- `src/workflows/registry.ts` — workflows defined as typed config (steps = `{dept?, task, gated}`),
  parameterized with `{slots}`. Pure + unit-tested. (Not YAML — code, per the LangGraph rule.)
- `src/workflows/runner.ts` — a pure-ish driver: for each step, render the templated task, invoke the
  office on a per-workflow thread, capture the result, feed it forward. Pauses on HITL exactly like a
  normal turn; resumes via the same approval card. A `WorkflowRun` row in Postgres tracks step/status
  (durable, resumable — reuses the checkpointer pattern).
- Trigger: `/run <workflow> <args>` (Phase 2 grammar) or the scheduler (Phase 3).
- **Guardrails:** every gated step still fires its HITL card; a workflow can be aborted; idempotency keys
  are per-step so a resumed workflow never double-sends.

**Triple-filter:** outcome = real multi-step company ops run in one command; hiring signal = a
durable, resumable workflow-orchestration engine on LangGraph (strong); reuse = office + checkpointer +
memory + scheduler, ~one thin runner of net-new code.

TDD: registry (pure) → runner step-advance logic (pure, fake office) → durable run state → live.

---

## Phase 2 — Power-User Command Grammar

_/q direct-to-dept and /run shipped in Phase 1. Remaining Phase 2: /runs (cost history), macros._

A terse, scriptable surface over the office and workflows. All deterministic (no LLM) where possible.

- `/run <workflow> [k=v ...]` — run a workflow (e.g. `/run onboarding company=Acme`).
- `/workflows` — list available workflows + params.
- `/q <dept> <task>` — direct-to-department, bypass the supervisor (faster, power-user precision).
- `/runs [n]` — recent runs with status, per-run cost (USD) + tokens (surfaces the budget guard data).
- `/batch` — apply one task across a list (reuse the existing `/outbound` batch machinery).
- **Macros**: `src/gateway/macros.ts` — founder-defined aliases (`/m <name>`), stored in `founder_context`.
- Keep natural-language chat fully working — the grammar is an *accelerator*, not a replacement.

TDD: command parsers are pure functions (like the existing `/context`, `/target` parsers) — easy to test.

---

## Phase 3 — Proactive + Propose (scheduled autonomy, HITL-safe)

Generalize the existing Monday-brief scheduler into a company-ops loop.

- **Daily ops digest** — one Telegram message: what each department did, pending approvals, run costs,
  stale items, today's scheduled workflows. (Reuses memory + budget + audit log.)
- **Scheduled workflows** — any Phase-1 workflow can be cron-scheduled (the weekly outbound rhythm becomes
  one instance of this, not a special case).
- **Watchers** — "watch {company/topic}" → periodic research that surfaces only on a meaningful change.
- **Propose discipline:** the system drafts and *surfaces* — it never sends without ✅. "Proactive" =
  initiative in *preparing* work; "propose" = the founder still approves every external action.

---

## Production-grade / best-practices (woven through all phases)

- **Observability:** per-run cost/latency surfaced (`/runs`, digest); complete audit trail; LangSmith
  traces; structured logs. **Graceful degradation:** clear behavior when Postgres/Redis/Composio/
  personal-rag is down (fail loud to the founder, never silent). **Idempotency** audited across every
  side-effect. **Config** consolidated (the env sprawl) in `core/config.ts`. **Tests:** gateway run-loop
  + workflow runner get direct unit tests; eval gains workflow-routing golden tasks. Every change: TDD,
  branch+PR, humans-only merge, real-path verification (rule #19), MEMORY + brain:sync updated.

## Recommended sequencing

```
Phase 0 (stabilize/clean)  →  Phase 1 (workflow engine)  →  Phase 2 (command grammar)
                                                          →  Phase 3 (proactive/propose)
```
Phase 0 first (clean base). Phase 1 is the keystone (the "runs a company" capability). Phase 2 makes it
power-user. Phase 3 makes it run itself. Each phase ships on its own branch + PR + TDD + eval, and becomes
build-in-public content.

## Open questions for the founder
1. First workflow to build as the reference SOP — **onboarding**, **weekly outbound**, or a **weekly
   company digest**? (I recommend onboarding — most end-to-end, best demo.)
2. Should `/q <dept>` (bypass-supervisor) ship in Phase 2, or is supervisor routing always preferred?
3. Daily digest time + timezone (Europe/Amsterdam assumed).
