# Coding standards for delegated work — BINDING

**Read this before writing code for any `AG-NNN` brief. It applies in full, every time.**

## Precedence

```text
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

A rule which is not enforced by layer 2 is a convention, and a rule that is enforced cannot be satisfied by argument.

A brief describes one task. This file describes how all code in this repo is written. Where a brief
is silent, this file governs. Where a brief explicitly overrides something here, the brief wins —
but it must say so out loud.

These are not preferences. Each one is here because breaking it cost real time, and several name the
incident that produced them.

---

## 1. Hard gates (CI fails, the change does not land)

| Rule | Enforced by |
|---|---|
| No file over **400 lines** | `pnpm verify:arch` — `loc-budget` |
| No `any`. Use `unknown` and narrow | `pnpm lint` (`tsc --noEmit`, strict) |
| Import direction: `contracts ← kernel ← gateway`. The kernel may import only `kernel/core/db/infra/tools` | `verify:arch` — `kernel-purity`, `gateway-imports` |
| No routing or parsing by regex on user text | `verify:arch` — `regex-routing` |
| A fail-open `catch` needs an `// allow-failopen: <reason>` tag | `verify:arch` — `fail-open-catch` |
| Killed modules must not be re-created (tombstones) | `verify:arch` |

The architecture baseline is a **ratchet** (`governance/architecture-baseline.json`): counts may
shrink, never grow. If your change raises a count, the change is wrong — do not raise the baseline.

---

## 2. Purity and I/O placement

**Analyzers, resolvers, rankers, scorers, and guards are pure functions over already-fetched data.**
They take plain arrays and return plain arrays. No `fs`, no network, no database, no `Date.now()`,
no environment reads.

All I/O lives in a **collector** module, which fetches and maps and does nothing else. See
`src/evolution/collect.ts` for the pattern.

**Why:** a pure function is testable with an array literal, runs in CI at $0, and is reproducible.
The moment an analyzer reads a file itself, the test needs a fixture directory, CI needs a database,
and the "sensor" can no longer be trusted to give the same answer twice.

Corollary: **narrow the row type at the collector boundary.** An analyzer that sees the full drizzle
row will eventually depend on a column it has no business knowing about.

---

## 3. Reachability is computed from resolved import specifiers, never from raw file text

Any analysis of "does X reference Y" must parse import/export statements and resolve the specifier.
Never `text.includes(path)`.

**Why (this one has now cost five wrong answers):** a doc comment merely *mentioning*
`src/outreach/graph.ts` made an entirely dead subsystem look alive during the 2026-08-06 hand audit.
The AG-001 brief then specified raw-text matching, and it produced two more silent false negatives —
`src/outreach/graph.ts` looked tested because a test imported `src/kernel/graph.js`, and
`src/kernel/worker.ts` looked tested because a test mentioned `src/kernel/worker-utils`.

Use the exported `resolveImport` from `src/evolution/analyzers/dead-code.ts`. **Do not write a
second copy of a resolver.** One resolver, one behaviour.

---

## 4. Failure direction: prefer loud over silent

When a check can be wrong in two directions, choose the one that is visible.

A sensor that under-reports is worse than no sensor, because it manufactures confidence. A module
with no tests reported as tested simply disappears from the audit; nobody ever learns it was missed.

Concretely:
- Guard divide-by-zero and empty inputs explicitly, and return `[]` — never emit a finding computed
  from nothing.
- Parse `numeric` DB columns with `Number(...)` **and** check `Number.isFinite`. A single `NaN`
  silently poisons every sum downstream and produces a confidently wrong report.
- Never swallow an error to keep a pipeline green. If a fail-open is genuinely correct, tag it
  `// allow-failopen: <reason>`.

---

## 5. Constants and thresholds

Every threshold, limit, budget, or magic number is a **named exported constant**, declared at the
top of the module with a one-line comment saying what it means. Tests import the constant rather
than repeating the literal.

```ts
/** Worker prompt files max line budget before token bloat warning. */
export const PROMPT_MAX_LINES = 100;
```

Never inline a number into a comparison.

---

## 6. Output must be legible to someone who has never read the code

Anything that can reach the founder — `evidence` strings, findings, briefs, Telegram messages —
must be a full sentence containing the actual numbers and the actual subject.

- `"3 failures"` is not evidence.
- `"src/tools/email.ts failed under 4 distinct signatures in the last 30 days"` is.

An internal label nobody defined ("partially overlaps", "not checked", "Sponsor") is not
information. Print every reason with its own result. Split a message rather than hide a row.

**And it must end in something actionable** — a ranked list, a named component, a decision, a number
that changes a choice. A log of what happened is not an outcome. Sort output so the largest lever is
on the first line; the founder reads top-down.

---

## 7. Immutability and shape

- Return new arrays and objects. Never mutate an input. Inputs are typed `readonly`.
- `interface` fields are `readonly` unless there is a reason otherwise.
- Additive changes to shared type files only — do not restructure `Finding`, `Severity`, or any
  contract type as a side effect of a feature.
- Prefer early returns over nesting. Max 4 levels.
- Functions under 50 lines, files 200–400.

---

## 8. Naming and style

- `camelCase` functions/variables, `PascalCase` types/interfaces, `UPPER_SNAKE_CASE` constants.
- Booleans read as predicates: `isOver`, `hasReceipt`, `shouldRetry`.
- **Match the surrounding file.** Do not restyle, reformat, or "improve" adjacent code. Do not
  delete dead code you happen to notice — mention it in your close-out report instead.
- Every changed line must trace to the brief. Nothing else.

---

## 9. Tests

- Every analyzer or pure function gets **at least one true positive and one true negative.** The
  negative is the one that catches over-matching, and it is the test that keeps being missing.
- Fixtures only. No database, and no mocking of the database, in a unit test.
- Arrange–Act–Assert; test names state the behaviour
  (`"does NOT treat a path-prefix sibling as coverage"`).
- A bug fix **starts with a failing test.** Write it, run it, watch it fail, then fix. If it passes
  before your change, the fixture is wrong and you have proved nothing.
- Existing tests must stay green. They are the evidence you broke nothing.

---

## 10. Cost

- **Zero paid API calls.** No LLM call, no network call, in the dev loop or in a test. Ollama is
  local and free; anything else is not.
- No new npm dependency without an explicit instruction in the brief.

---

## 11. Never, without an explicit instruction in the brief

- Commit, push, rebase, force-push, change branch, or open a PR.
- Edit CI config, `.env`, secrets, or credentials.
- Delete a file not named in the brief.
- Run a destructive command (`rm -rf`, `git reset --hard`, a database drop).
- Add `console.log`.
- Create a new abstraction, config file, or directory the brief did not ask for.

---

## 12. Close-out

Run the brief's verify command yourself and **paste its raw output**, not a summary. If you could
not run it, say so and say why. Never claim a result you did not observe.

State anything you skipped or assumed. Silence is read as "nothing was assumed."

**Do not report the task as "done."** Report what changed and what verify printed. A human reads
`git diff` in full and re-runs verify before anything is accepted — the executor is never its own
grader.
