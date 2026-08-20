# AG-008 — Populate `agent_results` telemetry and expose P50/P95 turn latency

**Milestone:** observability (audit fix #1)
**Branch:** `fix/latency-percentiles` — cut from fresh `origin/main`. PR base: `beta`.
**Status:** dispatched
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

FounderOS cannot answer "what is your P50/P95 latency?" — the single most common production
question in an AI engineering interview. The reason is not that the metric is hard: the column
already exists and nothing writes it.

`agents.agent_results` declares `latency_ms`, `cost_usd`, and `tools_used`. Its **only** writer is
`src/kernel/synthesizer.ts:130`, which passes five fields and omits all three. Every row ever
written has those three columns NULL.

**Done means:** every completed turn writes a real `latency_ms` and a real `tools_used` array, and
`pnpm proof:scoreboard` (or a new query you expose) can print P50/P95/P99 turn latency over a date
range. `cost_usd` is **out of scope** — AG-009 owns cost attribution; do not touch it.

---

## Measured starting state — verify these yourself before you begin

If your numbers differ, **stop and report**. The tree has moved and this brief is stale.

```bash
# 1. Exactly one caller of writeTaskOutcome in src/
grep -rn "writeTaskOutcome(" src/ | grep -v "export async function"

# 2. latency_ms appears ONLY in the schema — no writer, no reader
grep -rn "latency_ms" src/ tests/
```

| Measure | Value |
|---|---|
| `writeTaskOutcome` callers in `src/` | **1** — `src/kernel/synthesizer.ts:130` |
| Fields that call passes | **5** — `agent_id`, `thread_id`, `outcome`, `decision_summary`, `tenant_id` |
| Occurrences of `latency_ms` in `src/` | **1** — `src/db/schema.ts:277` (the declaration) |
| Occurrences of `p50`/`p95`/`percentile` in the whole repo | **0** |

The turn start time is **already in kernel state** — no plumbing required:

```ts
// src/kernel/contracts.ts:277
export interface TurnRecord {
  id: string;
  chat_id: string;
  received_at: string;   // ISO 8601 — this is your t0
  raw_input: string;
}
```

`synthesizer.ts` already reads `state.turn?.id` on line 132, so `state.turn` is in scope there.

---

## Files in scope

| Path | Change |
|---|---|
| `src/kernel/synthesizer.ts` | add `latency_ms` + `tools_used` to the existing `writeTaskOutcome` call |
| `src/db/queries.ts` | **new** exported function `getTurnLatencyPercentiles(tenantId, days)` |
| `tests/unit/kernel/` | test that the synthesizer computes latency and tool names correctly |
| `tests/unit/db/` | test the percentile function against a fixture (pure math, no live DB) |

Nothing else. **Do not touch `src/db/schema.ts`** — every column you need already exists, so this
task requires no migration. **Do not touch `cost_usd`** — that is AG-009's file surface.

---

## The pattern to follow

**Computing latency.** `state.turn.received_at` is an ISO string. Guard against a missing or
unparseable value — return `null`, never `NaN` or a negative number, and never throw. The
`writeTaskOutcome` call is already fire-and-forget with a `.catch()`; keep that shape.

**Computing `tools_used`.** The exact expression already exists in `src/eval/kernel-invoker.ts:38`:

```ts
const tools = res.results.flatMap((r) =>
  r.status === "ok" ? r.tool_receipts.map((t) => t.tool) : [],
);
```

Reuse that shape against `state.results`, de-duplicated with `[...new Set(tools)]`. **Grep first** —
if a shared helper for this already exists in `src/kernel/`, import it rather than writing a third
copy. (CLAUDE.md rule #25: "Does it already exist?")

**Percentiles.** Compute them in SQL with `percentile_cont`, and follow the existing aggregate-query
shape in `src/db/queries.ts:211-230` (`getCostBreakdown`) for the drizzle `sql<T>` idiom, the
`since`-date filter, and the tenant predicate. Exclude NULL `latency_ms` rows from the calculation
and **return the excluded count alongside the percentiles** — a percentile computed over 3 of 400
rows must not be indistinguishable from one computed over all 400. That distinction is the whole
point of `src/infra/rag-optimization-sweep.ts`; read its header comment before you design the
return shape.

---

## Explicitly forbidden

- **No migration.** If you believe a schema change is required, stop and report — it means you have
  misread the brief.
- **No new dependency** for percentile math. Postgres `percentile_cont` does this natively.
- **Do not make `writeTaskOutcome` blocking or awaited.** It is deliberately fire-and-forget; a
  telemetry write must never be able to fail a founder's turn.
- **Do not change the `outcome` values** or any other existing field semantics.
- Do not touch `cost_usd`, `lead_id`, or `user_feedback`.

---

## Verify

Run this and **paste the raw output** into your close-out — not a summary of it:

```bash
pnpm lint && pnpm verify:arch && pnpm test
```

Then prove the metric is real, not just typed:

```bash
grep -rn "latency_ms" src/kernel/synthesizer.ts src/db/queries.ts
```

In the PR body, state explicitly whether you observed a non-NULL `latency_ms` row against a live
database, or whether the change is unit-verified only. **"NOT VERIFIED — reason" is an acceptable
answer; a claim of live verification that did not happen is not.** (CLAUDE.md rule #24.)
