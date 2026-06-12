# Turn-Tracing Observability + Test Streamlining — Design Spec

**Date:** 2026-06-12
**Branch:** `obs/turn-tracing`
**Author:** senior-QA pass (pushkar + assistant)
**Status:** Approved (design) — pending implementation plan

---

## Problem

Every P0/P1 bug in the last two weeks (wedged-interrupt loop, duplicate bot
instances, stale-reply display, reject-loop) shared one fingerprint: **passed the
unit + eval suite, failed in production.** They were not single-node miscalculations
— they lived in the *seams* between gateway ↔ office ↔ HITL ↔ checkpointer.

Current debugging loop is **A → B → D**: tail `/tmp/founderos.log` (raw lines) →
re-run a probe → guess-and-restart. The durable state (`action_log`,
`hitl_approvals`, checkpoints) is never used for diagnosis (**C is absent**) because
nothing correlates those rows back to "the turn that just broke."

**Architectural constraint:** `office.ts` uses *prebuilt* `createSupervisor` +
`createReactAgent` (`office.ts:19-143`). There are **no hand-written graph nodes** to
instrument or unit-test. The supervisor routing and each ReAct loop are opaque
library black boxes. Therefore observability and testing must target the **seams we
own**, not nodes we don't.

## Core Insight (senior-QA reframe)

**Observability and testability are the same thing — you can only assert what you can
observe.** The trace layer is not just a debugging aid; it is the **test oracle**.
This collapses observability, the seam refactor, and test streamlining into one system.

## Non-Goals (YAGNI)

- **No custom trace dashboard/UI** — LangSmith already is that.
- **No new Postgres `turn_trace` table** — structured logs + LangSmith cover it
  without adding schema or migration complexity.
- **No node-level unit tests** — there are no custom nodes (see constraint above).
- **No rewrite of the prebuilt supervisor/ReAct graph** — only the seams around it.

---

## Thread 1 — Observability (the spine, built first)

### `src/infra/trace.ts`

A `TurnTrace` created per inbound message:

```
TurnTrace {
  turnId: string        // correlation id (nanoid/uuid)
  chatId: string
  promptHash: string    // sha256 of active system prompt → catches prompt regressions
  t0: number
  events: TraceEvent[]
}
TraceEvent { turnId, seam, ms, ...data }
```

One API: `trace.event(name, data)` — appends a record and emits it through the
existing `logger.ts` as a single structured JSON line stamped with `turnId` and
elapsed-ms since `t0`.

**Seams (risk-ordered):** `turn.in` · `route.decided` · `tool.call` · `tool.result`
· `tool.error` · `hitl.interrupt` · `hitl.resume` · `wedge.recovered` ·
`checkpoint.trim` · `turn.out`.

**Debug story:** `grep <turnId> /tmp/founderos.log` reconstructs the entire turn as an
ordered narrative. This directly replaces A (raw lines) and D (guessing).

### LangSmith activation

- Flip on via env (`LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY`). `telemetry.ts`
  is already wired and a graceful no-op when the key is absent.
- Stamp `turnId` + `promptHash` into run metadata via the existing
  `buildRunMetadata` (`telemetry.ts:88`).
- LangSmith becomes the *visual* view of the same events that go to the logs.

### Determinism / safety

- Trace emission must be **non-throwing** — a trace failure can never break a turn
  (wrap in try/catch, log-and-continue). Fail-safe, not fail-loud (the turn's own
  errors still surface to Telegram per rule #19.5).
- PII scrubbing reuses `scrubObject`/`scrubPii` from `telemetry.ts` before any event
  is emitted.

---

## Thread 2 — Refactor the seam into `src/gateway/office-run.ts`

The gateway run-loop leaves `telegram.ts` and becomes the **single instrumented
boundary**: office invoke, interrupt-guard, history-trim, resume, wedge-recovery —
all emitting trace events from one file instead of logging scattered across
`telegram.ts` / `office.ts` / tools. `telegram.ts` shrinks to transport +
registration (this is the already-deferred architect item **C1**).

**Dead-infra pruning is evidence-gated:** only remove what traces + `grep` prove
unreferenced (candidate: dormant `redis.ts`). No speculative deletion.

**Sequencing guard (rule #19):** Thread 2 ships only *after* Thread 1 is verified live
on real turns, so a regression is attributable to one thread, not two.

---

## Thread 3 — Test streamlining (senior-QA pyramid)

The suite gives false confidence because it asserts the wrong altitude. Replace the
sprawl with **four explicit tiers, each owning a named risk, with the trace layer as
oracle:**

| Tier | Owns | Style | Gate |
|---|---|---|---|
| **Unit** | pure logic (guards, slicing, parsing, routing keywords) | fast, no I/O | must-pass |
| **Seam** *(NEW)* | run-loop: ordered trace events for a turn, **fake office** | golden-trace snapshot | must-pass |
| **Contract** | each tool's exact action name + field names + soft-fail + no-audit-on-fail | per TESTING-RULES | must-pass |
| **Real-path** | one consolidated MTProto harness | live; evidence = bot reply + `action_log` row | advisory/manual |

### Senior-QA moves baked in

1. **Golden-trace snapshots.** Capture a turn's canonical trace-event sequence and
   assert against it. A routing regression / dropped HITL / wedge-loop surfaces as a
   *trace diff* at the Seam tier — the exact class that currently reaches prod.
2. **Deterministic gate vs. flaky lane.** The eval is non-deterministic (Gemini
   capacity, per MEMORY.md). LLM-dependent checks move to an explicit **advisory
   lane**; the merge gate is 100% deterministic. One command — `pnpm gate` — runs
   Unit + Seam + Contract and returns a clean pass/fail.
3. **Consolidate 3 probes → 1 tiered harness.** `probe-real-task.ts`,
   `e2e-telegram-qa.ts`, `telegram-tester.ts` overlap; collapse into one harness with
   clear modes (single-task / full-suite / crash-recovery) over the real MTProto path.

---

## Sequencing (one branch, attributable commits)

1. **Thread 1** — `trace.ts` + seam instrumentation + LangSmith on → **verify live**
   on several real turns (grep one `turnId` end-to-end; confirm LangSmith span).
2. **Thread 2** — extract `office-run.ts`; move seams into it; evidence-gated prune.
3. **Thread 3** — define pyramid; add Seam tier + golden traces; `pnpm gate`;
   consolidate probes.

Each thread = its own commit. `pnpm test` green + tsc clean after each.

## Verification (definition of done, per rule #19 + Verification-First protocol)

- `grep <turnId>` yields the full ordered turn narrative for a real Telegram message.
- LangSmith shows the same turn with `turnId` + `promptHash` metadata.
- A deliberately broken seam (e.g. forced wedge) produces a **failing golden-trace
  diff** at the Seam tier — proving the tier catches what unit tests miss.
- `pnpm gate` is deterministic across 3 consecutive runs (no flaky failures).
- Bot restart is clean: single instance, 0× 409, real turn traced end-to-end.

## Portfolio framing (ADR-014 triple-filter)

- **Real outcome:** debugging loop A/B/D → one grep; regressions caught pre-merge.
- **2026 hiring gaps closed:** eval harness · production observability · cost control
  (per-turn timing in every trace).
- **Mostly reuse:** builds on existing `logger.ts`, `telemetry.ts`,
  `buildRunMetadata`, TESTING-RULES; no net-new subsystem.

Resume line: *"Turn-level distributed tracing + golden-trace regression testing +
deterministic CI gate for a non-deterministic LLM multi-agent system."*
