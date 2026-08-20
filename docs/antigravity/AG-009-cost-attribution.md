# AG-009 — Attribute LLM cost to the worker that spent it

**Milestone:** observability (audit fix #2)
**Branch:** `fix/cost-attribution` — cut from fresh `origin/main`. PR base: `beta`.
**Status:** dispatched
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

FounderOS records what it spends per **day** but cannot say what it spends per **task**. The
`agents.ai_call_costs` table is well designed for attribution — it has `agent`, `tier`, and a
`lead_id` FK explicitly commented "enables per-lead cost attribution" — but the kernel writes a
constant into two of those columns and never sets the third.

`src/gateway/kernel-run.ts:69` (`kernelCostSink`) hardcodes `agent: "kernel"` and `tier: "primary"`
for **every** LLM call in the system. So the planner, each worker, and the synthesizer are
indistinguishable in the ledger. "What does a job screen cost versus a research task?" is
unanswerable from data we are already collecting and paying to store.

**Done means:** `ai_call_costs.agent` identifies which kernel stage and which worker spent the
money, `tier` distinguishes planner / worker / synthesizer / fallback, and
`getCostBreakdown` can produce a per-worker cost table.

---

## Measured starting state — verify these yourself before you begin

If your numbers differ, **stop and report**.

```bash
grep -n "agent:\|tier:" src/gateway/kernel-run.ts
grep -rn "BudgetGuardCallback(" src/
```

| Measure | Value |
|---|---|
| `kernelCostSink` location | `src/gateway/kernel-run.ts:69` |
| Hardcoded `agent` value | `"kernel"` — for every call |
| Hardcoded `tier` value | `"primary"` — for every call |
| `BudgetGuardCallback` construction sites in `src/` | **1** — `makeBudgetCallback()`, `kernel-run.ts:81` |
| Distinct `agent` values in the ledger today | **3** — `"kernel"`, plus whatever `gap-scan-budget.ts` and `creative.ts` write |

The relevant constructor (`src/infra/budget.ts:204`):

```ts
constructor(
  private readonly tracker: BudgetTracker,
  private readonly modelId: string = "gemini-2.5-flash",
  private readonly onAccrue?: (call: {
    model: string; inputTokens: number; outputTokens: number; usd: number;
  }) => void,
) { super(); }
```

Note the sink payload carries **no stage or worker identity**. That is the actual defect — the
callback is attached once per run and has no idea which graph node is invoking the model. Widening
that payload is the core of this task.

---

## Files in scope

| Path | Change |
|---|---|
| `src/infra/budget.ts` | widen the `onAccrue` payload to carry stage/worker identity |
| `src/gateway/kernel-run.ts` | `kernelCostSink` writes the real identity instead of constants |
| `src/gateway/kernel-boot.ts` | pass stage identity when wrapping planner vs worker models |
| `src/db/queries.ts` | extend `getCostBreakdown` to group by worker |
| `tests/unit/infra/`, `tests/unit/gateway/` | cover the new attribution |

Nothing else. **Do not touch `src/kernel/synthesizer.ts`** — AG-008 owns that file on a parallel
branch and you will conflict with it.

---

## The pattern to follow

`src/gateway/kernel-boot.ts` is the single composition root and already distinguishes the two model
classes: `getConfiguredModelId()` at line 183 (planner) and `getWorkerModelId()` at line 191
(worker). That existing split is your seam — the identity is **already known at construction
time**, so thread it through rather than trying to infer the caller at accrual time.

Prefer a small explicit object over positional arguments. Keep the sink's contract intact in one
respect: it **must not throw**. The existing `.catch()` at `kernel-run.ts:78` carries an
`// allow-failopen:` tag; if you add another catch, tag it the same way or `pnpm verify:arch` will
fail you.

**Decide and state one thing in the PR body:** whether `agent` carries the worker id
(`"jobhunt"`, `"research"`, …) with `tier` carrying the stage (`"planner"`, `"worker"`,
`"synthesizer"`, `"fallback"`), or the reverse. Either is defensible; an inconsistent mix is not.
Whatever you pick, **update the column comments in `src/db/schema.ts`** so the next reader is not
guessing.

---

## Explicitly forbidden

- **No migration and no new columns.** `agent`, `tier`, and `lead_id` all already exist.
- **Do not populate `lead_id` from the kernel.** It is a real FK to `outbound_leads`; writing a
  non-lead value into it would corrupt the sales attribution path. Out of scope.
- **Do not make the cost write blocking.** It is `void`-ed and fire-and-forget on purpose.
- **Do not change `estimateCost` or `MODEL_COSTS`.** Pricing is not in scope; attribution is.
- Do not edit `src/kernel/synthesizer.ts` (AG-008 owns it).

---

## Verify

Run this and **paste the raw output**:

```bash
pnpm lint && pnpm verify:arch && pnpm test
```

Then demonstrate the attribution is real:

```bash
grep -n "agent:" src/gateway/kernel-run.ts
```

In the PR body, show a sample of what a `getCostBreakdown` row now looks like. State explicitly
whether you confirmed it against a live database or unit tests only — **"NOT VERIFIED — reason" is
acceptable; an unearned claim of live verification is not.**
