# AG-001 — M0a static analyzers

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Milestone:** M0a — Evolution Engine v0

---

## Goal

FounderOS is growing a self-audit sensor: a set of **pure analyzers** that inspect the source tree
and emit typed `Finding` objects describing what is wrong with the codebase. One analyzer module
already exists and works. Your job is to add **three more static analyzers** in a new module,
following the existing pattern exactly, with unit tests for each.

"Done" means: three analyzers implemented, each with unit tests covering its true-positive and its
false-positive case, and the verify command below passing with no failures.

---

## Read this first — the pattern to follow

**`src/evolution/analyzers/dead-code.ts`** is the reference implementation. Read it fully before
writing anything. Note especially:

- Analyzers are **pure functions**. They take `readonly SourceFile[]` and return `Finding[]`.
  They perform **no file I/O** — all reading happens in `src/evolution/collect.ts`.
- `SourceFile` and `Finding` are defined in **`src/evolution/types.ts`**. Read that too.
- `Finding.evidence` must be **legible to someone who has never read the code**: state what was
  measured and what the measurement was. Never an internal label, never a bare symbol name.
- Named constants at module top, not magic numbers inline.
- Doc comments explain *why*, especially any false-positive trap the analyzer guards against.

**`tests/unit/evolution/dead-code.test.ts`** is the reference test file. Follow its structure:
one `describe` per analyzer, a true-positive test, and at least one test proving a specific
false positive does **not** occur.

---

## Files in scope

**Create exactly these two files. Touch nothing else.**

| Path | Contents |
|---|---|
| `src/evolution/analyzers/code-health.ts` | The three analyzers below |
| `tests/unit/evolution/code-health.test.ts` | Unit tests for all three |

Import types with `import type { Finding, SourceFile } from "../types.js";` and re-export them the
same way `dead-code.ts` does.

---

## The three analyzers

### 1. `findOversizedPrompts(files: readonly SourceFile[]): Finding[]`

Worker prompt files live in `src/agents/prompts/`. They vary wildly in size (one is 125 lines,
another is 28). Prompt bloat is a real cost and quality signal: long prompts cost tokens on every
single turn and correlate with unclear worker boundaries.

- Consider only files whose path starts with `src/agents/prompts/`.
- Flag any file with **more than 100 lines**. Export the threshold as a named constant.
- `severity: "medium"`. `kind: "oversized-prompt"`.
- Evidence must state the actual line count and the threshold, e.g.
  *"src/agents/prompts/marketing.ts is 125 lines, over the 100-line prompt budget. Every turn that
  routes to this worker pays for the whole prompt in input tokens."*

### 2. `findUntestedModules(files: readonly SourceFile[], testFiles: readonly SourceFile[]): Finding[]`

A `src` module is untested if **no** test file mentions its module path.

- A module counts as tested if any test file's text contains its path without the `.ts` extension
  (e.g. `src/kernel/worker.ts` is tested if a test mentions `src/kernel/worker`) **or** contains
  `/<basename>.js` (e.g. `/worker.js`), which is how the existing tests import.
- **Skip** these — they are not meaningfully unit-testable and would be noise:
  `src/index.ts`, any file whose basename is `index`, and any file under `src/db/` whose basename is
  `schema` (pure table declarations).
- `severity: "low"`. `kind: "untested-module"`.
- Evidence must name the module and say plainly that no test file references it.

### 3. `findFilesNearLocBudget(files: readonly SourceFile[]): Finding[]`

CI hard-fails any `src` file over **400 lines** (`scripts/verify-architecture.ts` rule R4). This
analyzer is an **early warning** so a file is split before it blocks a merge.

- Flag files at **360 lines or more** (90% of the budget). Export both numbers as named constants.
- Files **already over 400** are pinned in the CI baseline; still flag them, with `severity: "high"`.
  Files between 360 and 400 get `severity: "medium"`.
- `kind: "loc-pressure"`.
- Evidence must give the line count, the 400-line budget, and how many lines of headroom remain
  (or how far over it is).

---

## Extending the Finding type

`FindingKind` in `src/evolution/types.ts` is a closed union. You must add the three new kinds
(`"oversized-prompt"`, `"untested-module"`, `"loc-pressure"`) to the `FINDING_KINDS` array.

**That single edit to `types.ts` is the only change permitted outside your two new files.**
Do not change anything else in that file — not the interfaces, not the comments, not `Severity`.

---

## Explicitly forbidden

- **Do not modify** `src/evolution/analyzers/dead-code.ts`, `src/evolution/collect.ts`, or any
  existing test file.
- **Do not modify** `src/evolution/types.ts` beyond adding the three strings to `FINDING_KINDS`.
- **Do not** perform file I/O inside an analyzer — no `readFileSync`, no `fs`, no `path` reads.
  Analyzers receive already-read text.
- **Do not** add any npm dependency.
- **Do not** exceed 400 lines in either new file (CI enforces this).
- **Do not** use `any`. Use `unknown` and narrow, per the repo's TypeScript rules.
- **Do not** add `console.log`.
- **Do not** touch any file outside the three listed above.
- **Do not** change git branch, rebase, force-push, or open a PR.

---

## Verify

Run this exact command and **report its raw output in full**, including any failures:

```bash
cd /Users/pushkarverma/Projects/founderos && npx vitest run tests/unit/evolution/ && pnpm lint && pnpm verify:arch
```

All three parts must pass:
- vitest: every test green, including the pre-existing `dead-code.test.ts` and
  `acceptance-rederive.test.ts` which must **remain** green.
- `pnpm lint` (`tsc --noEmit`): no output means success.
- `pnpm verify:arch`: must print "Architecture gates green" and the counts must **not** rise above
  the pinned baseline.

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human will read `git diff` in full and re-run the verify command before this is accepted.
Do not commit anything beyond your two new files plus the single `FINDING_KINDS` line, and do not
summarize the work as "done" — report the raw verify output and stop.
