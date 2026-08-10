# AG-006 — M0a output surface: ranking and the founder-facing report

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Standards:** read **[`docs/antigravity/STANDARDS.md`](STANDARDS.md)** in full first. It is binding.
**Depends on:** AG-001, AG-002, AG-003 (all merged — six analyzers exist and are green)

---

## Goal

Six analyzers now produce `Finding[]`. Nothing orders them and nothing renders them, so the sensor
currently has **no output** — it can detect problems and cannot tell anyone about them.

This task builds the two pure functions that close that gap:

- `rankFindings` — one deterministic total order over all findings, most actionable first.
- `renderReport` — that ranked list as a Telegram-ready text block.

The wiring (scheduler cadence, actually sending the message) is **not** in scope and is handled
separately. Build the two functions and their tests; nothing else.

"Done" means: both functions exist as pure functions, are unit-tested with fixtures, and the verify
command below is green.

**Why this matters more than it looks:** a log of what happened is not an outcome. If the founder
can ignore this output at no cost and receive no signal, the design has failed regardless of how
many tests pass. Ordering *is* the product here — it is what turns nine findings into "fix this
one first".

---

## Read this first — the pattern to follow

**`src/evolution/analyzers/telemetry.ts`** and **`src/evolution/analyzers/code-health.ts`**. Read
both fully. Copy their shape: pure functions over plain arrays, named exported constants for every
threshold, evidence strings legible to someone who has never read the code.

`Finding`, `FindingKind`, `FINDING_KINDS`, and `Severity` are already defined in
**`src/evolution/types.ts`** — read it, and **do not modify it**. This task adds no new finding kinds.

---

## Files in scope

**Create exactly these four files. Touch nothing else.**

| Path | Contents |
|---|---|
| `src/evolution/rank.ts` | `rankFindings` + the ordering constants |
| `src/evolution/report.ts` | `renderReport` + formatting constants |
| `tests/unit/evolution/rank.test.ts` | ranking tests |
| `tests/unit/evolution/report.test.ts` | rendering tests |

---

## `src/evolution/rank.ts`

### The ordering

`export function rankFindings(findings: readonly Finding[]): Finding[]`

Returns a **new** array (never mutate the input) sorted by three keys, in this order:

1. **Severity descending** — `high`, then `medium`, then `low`.
2. **Kind priority ascending** — position in `KIND_PRIORITY` below.
3. **Subject ascending** — plain `localeCompare`. This exists purely so the order is *total*: the
   same input must always produce the same output, or the acceptance test for the whole sensor
   becomes flaky.

Export the severity ranking as a named constant rather than inlining it:

```ts
/** Severity ordering. Higher sorts first. */
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { high: 3, medium: 2, low: 1 };
```

### `KIND_PRIORITY`

Export as `readonly FindingKind[]`, in exactly this order, with the comment explaining the
principle preserved:

```ts
/**
 * Findings ordered by how directly acting on one changes an outcome.
 * Money and silent defects first; risk and tidiness last. A finding nobody
 * can act on this week ranks below one that can be fixed by deleting a line.
 */
export const KIND_PRIORITY: readonly FindingKind[] = [
  "unapplied-lesson",   // the kernel learned something and never used it — silent, and the memory layer rests on it
  "cost-hotspot",       // directly moves money
  "recurring-failure",  // names a specific component to fix
  "unused-dependency",  // cheapest possible win: delete a line
  "orphan-module",      // amputation candidate: removes whole files
  "dead-export",        // narrower amputation
  "oversized-prompt",   // paid for in input tokens on every routed turn
  "loc-pressure",       // refactor pressure, no immediate cost
  "untested-module",    // risk, not a present defect
];
```

**A kind missing from `KIND_PRIORITY` must sort last, not crash.** Treat an unknown kind as index
`KIND_PRIORITY.length`. Add a test for this — it is what stops a future analyzer from throwing in
production because someone forgot to update an array.

---

## `src/evolution/report.ts`

`export function renderReport(findings: readonly Finding[], opts?: RenderOptions): string`

Where `RenderOptions` is `{ readonly maxItems?: number }`, defaulting to `DEFAULT_MAX_ITEMS`.

### Behaviour

- Input is assumed **already ranked** — `renderReport` does not sort. Keep the two responsibilities
  separate so each is testable alone.
- **Empty input returns a single clean line**, not an empty string and not a fake-cheerful message:
  `"Self-audit: no findings."`
- Otherwise:
  - A header line with the total count and the breakdown by severity, e.g.
    `"Self-audit: 14 findings (3 high, 6 medium, 5 low)"`.
  - Then up to `maxItems` findings, one block each, in the order received.
  - Each block is the severity marker, the subject, and the evidence sentence on its own line.
    Use a plain uppercase severity marker (`HIGH` / `MED` / `LOW`) — **no emoji**, and no Markdown
    or HTML formatting characters. This output has been sent as HTML before and rendered raw job
    titles as broken markup; plain text avoids the whole class of bug.
  - **If findings were withheld, say so explicitly on its own final line**:
    `"+ 7 more not shown (14 total)."` Silently truncating a list is forbidden — a hidden row and an
    empty result are indistinguishable from the outside, and that ambiguity has already cost this
    project weeks.

### Constants

```ts
/** Telegram hard-caps a message at 4096 characters; leave room for the gateway's own wrapper. */
export const TELEGRAM_SAFE_CHARS = 3500;

/** Findings shown before the "+ N more" line. */
export const DEFAULT_MAX_ITEMS = 12;
```

`renderReport` must **also** stop early if the accumulated string would exceed
`TELEGRAM_SAFE_CHARS`, and report the remainder with the same `"+ N more not shown"` line. A
`maxItems` cap alone is not sufficient — one finding with a very long evidence string can blow the
limit on its own.

---

## Required tests

### `rank.test.ts`
1. High sorts above medium sorts above low, regardless of input order.
2. Within one severity, `KIND_PRIORITY` decides: a `cost-hotspot` sorts above an `untested-module`.
3. Within one severity and one kind, subject sorts alphabetically.
4. **A kind absent from `KIND_PRIORITY` sorts last and does not throw.** Construct it by casting a
   made-up string through `FindingKind`.
5. The input array is **not** mutated — assert the original order is intact after the call.
6. The function is deterministic: calling it twice on the same input returns identical output.

### `report.test.ts`
7. Empty input returns exactly `"Self-audit: no findings."`.
8. Header counts are correct for a mixed-severity fixture.
9. Every shown finding's evidence text appears in the output.
10. With 20 findings and `maxItems: 5`, exactly 5 blocks appear **and** the output contains
    `"+ 15 more"`.
11. With few findings that fit, the output contains **no** `"more not shown"` line.
12. **A single finding with a 5000-character evidence string still returns a string under
    `TELEGRAM_SAFE_CHARS`**, and says something was withheld. This is the test that catches the
    real bug; write it first and watch it fail.
13. The output contains no `<`, `>`, `*`, or `_` formatting characters introduced by the renderer
    itself (fixture evidence must be free of them for this test).

---

## Explicitly forbidden — task-specific

General rules are in [STANDARDS.md](STANDARDS.md) and apply in full. Task-specific:

- **Do not** modify `src/evolution/types.ts`, `collect.ts`, `collect-telemetry.ts`, or anything
  under `src/evolution/analyzers/`. They are merged and reviewed.
- **Do not** modify any existing test file.
- **Do not** import from `src/db/`, `src/gateway/`, `src/kernel/`, or any Telegram/grammy module.
  These two functions are pure string-and-array code. `report.ts` knows Telegram's *character
  limit* and nothing else about Telegram.
- **Do not** sort inside `renderReport`, and do not render inside `rankFindings`.
- **Do not** add a new `FindingKind`.
- **Do not** touch `scripts/verify-architecture.ts`, `governance/architecture-baseline.json`,
  `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` — two other tasks own those files and
  editing them here causes a conflict.
- **Do not** wire anything into the scheduler or the gateway. Out of scope by design.

---

## Verify

Run this exact command and **report its raw output in full**, including any failures:

```bash
cd /Users/pushkarverma/Projects/founderos && npx vitest run tests/unit/evolution/ && pnpm lint && pnpm verify:arch
```

All three must pass:
- vitest: your new tests green, **and** the 40 existing tests in `dead-code.test.ts`,
  `code-health.test.ts`, `telemetry.test.ts`, and `acceptance-rederive.test.ts` still green.
- `pnpm lint` (`tsc --noEmit`): no output means success.
- `pnpm verify:arch`: "Architecture gates green", every count at baseline. Note `loc-budget` is
  pinned at 5 — if either new file exceeds 400 lines the gate fails, so keep them small.

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human reads `git diff` in full and re-runs verify before this is accepted. Report the raw verify
output and stop — do not summarize the work as "done".
