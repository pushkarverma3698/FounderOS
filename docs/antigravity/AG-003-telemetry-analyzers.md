# AG-003 — M0a telemetry analyzers (cost + failure sensors)

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Milestone:** M0a — Evolution Engine v0
**Depends on:** AG-001 + AG-002 (both merged; commit `a92d552`)

---

## Goal

The static analyzers in `src/evolution/analyzers/` audit the *code*. This brief adds the second
half of the M0a sensor: analyzers over *production telemetry* — what the system actually spent and
what actually failed.

Same architecture as the static side, and this is the binding constraint on the whole design:
**analyzers are pure functions over rows that were already fetched.** They perform no database
access, no I/O of any kind. All querying lives in one collector module. This is what lets the
self-audit run in CI at $0 against fixture rows, and be reproducible.

Three analyzers, each producing a finding a human can act on:

| Finding kind | Detects | Why it matters |
|---|---|---|
| `cost-hotspot` | one `agent`+`model` pair accounting for ≥25% of total spend in the window | Names the single lever that moves cost. Anything below that share is noise. |
| `recurring-failure` | a `component` with ≥3 distinct failure signatures | Says *which component to fix*. A count of failures is a log; a named component is a task. |
| `unapplied-lesson` | a lesson with `times_seen >= 3` and `times_applied = 0` | The kernel stores lessons and injects them into retries. A lesson never injected means that seam is broken — silently. The entire memory layer rests on it. |

"Done" means: the three analyzers exist as pure functions, are unit-tested with true-positive and
false-positive cases each, the collector fetches the rows, and the verify command below is green.

---

## Read this first — the pattern to follow

**`src/evolution/analyzers/code-health.ts`** and **`src/evolution/collect.ts`**. Read both fully
before writing anything. Copy their shape exactly:

- Every analyzer has the signature `(rows: readonly SomeRow[]) => Finding[]`. No `async`, no
  `await`, no imports from `src/db/`.
- Thresholds are **named exported constants** (`PROMPT_MAX_LINES`, `LOC_HARD_BUDGET` are the
  precedent), never inline magic numbers — the tests import the constants.
- `evidence` is a full sentence that is legible to someone who has never read the code, and
  contains the actual numbers. `"3 failures"` is not evidence. `"src/tools/email.ts failed under 4
  distinct signatures in the last 30 days"` is.
- The collector is the **only** module allowed to touch the database.

---

## Files in scope

**Create or modify exactly these four files. Touch nothing else.**

| Path | Change |
|---|---|
| `src/evolution/types.ts` | Add the three new `FindingKind` strings, and the two row types below. Change nothing else — do not touch `Finding`, `Severity`, or existing comments. |
| `src/evolution/collect-telemetry.ts` | **New.** The only file here that queries the DB. |
| `src/evolution/analyzers/telemetry.ts` | **New.** The three pure analyzers. |
| `tests/unit/evolution/telemetry.test.ts` | **New.** Unit tests, fixtures only, no DB. |

---

## Types to add to `src/evolution/types.ts`

Append the three kinds to the existing `FINDING_KINDS` array, preserving the existing entries and
their order:

```ts
"cost-hotspot",
"recurring-failure",
"unapplied-lesson",
```

Then add these two row types at the end of the file. They are deliberately **narrower than the
drizzle row types** — an analyzer must only see the columns it needs, so it cannot accidentally
depend on the database shape:

```ts
/** One row of ai_call_costs, narrowed to what the cost analyzers read. */
export interface CostRow {
  readonly agent: string;
  readonly model: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  /** Dollars. Parsed from the numeric column by the collector, never here. */
  readonly cost_usd: number;
}

/** One row of failure_lessons, narrowed to what the failure analyzers read. */
export interface LessonRow {
  readonly worker: string;
  readonly signature: string;
  readonly component: string;
  readonly times_seen: number;
  readonly times_applied: number;
}
```

---

## `src/evolution/analyzers/telemetry.ts`

Export these constants and three functions.

```ts
/** An agent+model pair at or above this share of window spend is the cost lever. */
export const COST_HOTSPOT_SHARE = 0.25;

/** Distinct failure signatures against one component before it is a pattern, not noise. */
export const RECURRING_FAILURE_MIN_SIGNATURES = 3;

/** Times a lesson must have been seen before "never applied" is a real defect. */
export const UNAPPLIED_LESSON_MIN_SEEN = 3;
```

### `findCostHotspots(rows: readonly CostRow[]): Finding[]`

Group rows by the composite key `` `${agent}:${model}` ``. Sum `cost_usd` per group and across all
rows. Emit a finding for every group whose share of total spend is `>= COST_HOTSPOT_SHARE`.

- `subject` = the `agent:model` key.
- `severity` = `"high"` if share `>= 0.5`, else `"medium"`.
- `evidence` must state the group's dollar total, the window total, the share as a whole-number
  percentage, and the call count. Example shape:
  `"admin:gemini-flash-latest cost $12.40 of $31.10 total (40%) across 214 calls."`
- Return findings sorted by cost **descending**. The founder reads the first line; the largest
  lever must be on it.
- **Guard the empty case:** an empty input array, or a total of `0`, returns `[]` — never divide by
  zero, never emit a finding claiming 100% of nothing.

### `findRecurringFailures(rows: readonly LessonRow[]): Finding[]`

Group by `component`. Count **distinct `signature` values** per component — not row count, since a
single signature recurring is one bug, not a pattern. Emit for components at or above
`RECURRING_FAILURE_MIN_SIGNATURES`.

- `subject` = the component.
- `severity` = `"high"` if distinct signatures `>= 5`, else `"medium"`.
- `evidence` states the component, the distinct-signature count, and the workers affected.
- Sort by distinct-signature count descending.

### `findUnappliedLessons(rows: readonly LessonRow[]): Finding[]`

Emit one finding per row where `times_seen >= UNAPPLIED_LESSON_MIN_SEEN` **and**
`times_applied === 0`.

- `subject` = `` `${worker}:${signature}` ``.
- `severity` = `"high"` — always. This one is not a suggestion: it means the kernel learned
  something and then never used it, which defeats the learning seam entirely.
- `evidence` states the worker, the signature, `times_seen`, and that it has never been injected
  into a retry.

---

## `src/evolution/collect-telemetry.ts`

One exported async function per row type. This is the **only** file in `src/evolution/` permitted
to import from `src/db/`.

```ts
export async function collectCostRows(sinceDays: number): Promise<CostRow[]>;
export async function collectLessonRows(): Promise<LessonRow[]>;
```

- Use the existing drizzle client the same way `src/db/queries.ts` does — read that file for the
  import path and client name. Do not create a new pool or client.
- `collectCostRows` filters `created_at >= now() - sinceDays`. Default the caller to 30 days.
- **`cost_usd` is a `numeric` column and arrives from the driver as a `string`.** Parse it with
  `Number(...)` in the collector and guard `Number.isFinite` — a `NaN` silently poisons every sum
  downstream and produces a confidently wrong cost report. Rows that fail the check are skipped.
- Map explicitly to the narrow row types. Do not spread the drizzle row.
- No analyzer logic in this file. It fetches and maps, nothing else.

---

## Required tests — `tests/unit/evolution/telemetry.test.ts`

Fixtures only. **No database, no mocking of the database, no import of `collect-telemetry.ts`.**
One `describe` block per analyzer, and each block must contain at least one true positive and one
true negative:

**`findCostHotspots`**
1. Flags a pair holding 40% of spend; asserts the subject, `medium` severity, and that the evidence
   contains both dollar figures and `"40%"`.
2. Does NOT flag five evenly-split pairs at 20% each (all below the 25% threshold). Assert `[]`.
3. Returns `[]` for an empty array, and `[]` when every row has `cost_usd: 0`. **This test must
   exist** — the divide-by-zero is the most likely defect in this file.
4. Sorts two hotspots with the more expensive one first.

**`findRecurringFailures`**
5. Flags a component with 3 distinct signatures.
6. Does NOT flag a component with 5 rows that all share **one** signature. This is the test that
   distinguishes a pattern from a single recurring bug — it is the point of the analyzer.

**`findUnappliedLessons`**
7. Flags `times_seen: 4, times_applied: 0`.
8. Does NOT flag `times_seen: 4, times_applied: 1`.
9. Does NOT flag `times_seen: 2, times_applied: 0` (below the seen threshold).

---

## Explicitly forbidden

- **Do not** import `src/db/` — or any database module — from `analyzers/telemetry.ts`. The
  analyzers must be callable with a plain array literal and nothing else.
- **Do not** modify `code-health.ts`, `dead-code.ts`, `collect.ts`, or any existing test file.
- **Do not** change `Finding`, `Severity`, or `SourceFile` in `types.ts`. Additive only.
- **Do not** make any network or LLM call. This sensor is $0 by construction.
- **Do not** use `any`. Use `unknown` and narrow.
- **Do not** add `console.log`.
- **Do not** add an npm dependency.
- **Do not** exceed 400 lines in any file (CI gate).
- **Do not** hardcode a threshold inline — every one is an exported named constant.
- **Do not** change git branch, rebase, force-push, or open a PR.

---

## Verify

Run this exact command and **report its raw output in full**, including any failures:

```bash
cd /Users/pushkarverma/Projects/founderos && npx vitest run tests/unit/evolution/ && pnpm lint && pnpm verify:arch
```

All three must pass:
- vitest: all tests green. The 30 existing tests in `dead-code.test.ts`, `code-health.test.ts`, and
  `acceptance-rederive.test.ts` must **remain** green — they are the proof nothing existing broke.
- `pnpm lint` (`tsc --noEmit`): no output means success.
- `pnpm verify:arch`: "Architecture gates green", every count at baseline
  (`gateway-imports 0 · kernel-purity 0 · fail-open-catch 11 · loc-budget 5 · regex-routing 0`).

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human will read `git diff` in full and re-run the verify command before this is accepted. Report
the raw verify output and stop — do not summarize the work as "done".
