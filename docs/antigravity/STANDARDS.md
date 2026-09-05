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
- **Never deliver a test for code you did not write.** A test importing a function that does not
  exist is not partial progress — it is a red suite that reports a false reason for being red.
  *(2026-08-06, AG-004: 16 tests shipped against five exports that were never implemented; the
  brief's own file was byte-unchanged. `pnpm lint` passed, because `tsconfig.json` excludes
  `tests/**/*`, so nothing mechanical caught it.)* Implementation and its tests land together or
  neither lands.
- **No untested claims.** Never claim a bug is fixed, a feature is completed, or a browser/pipeline component works without empirical runtime proof (passing unit tests or terminal execution). Label any unexecuted claim **NOT VERIFIED**.

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
- Run a destructive command (`rm -rf`, a database drop).
- **Discard work with git.** `reset`, `checkout --`, `restore`, `stash`, `clean`, or reverting a
  file to `HEAD` — all forbidden, including on files you wrote yourself in this task.
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

---

## 13. When you cannot make verify pass — STOP, do not clean up

This is the fork where a delegated task does the most damage, so it gets its own rule.

If the verify command is red and you cannot make it green, you have exactly one permitted move:
**stop, leave the tree exactly as it is, and report the failure with the raw output.** A red tree
with an honest report is a completed task. It tells the reviewer precisely what the brief got wrong.

**Reverting your own work to make the tree look clean is the single worst available outcome.** It
destroys the evidence, produces a green summary over an empty diff, and burns a full review cycle
proving that nothing happened.

*(2026-08-06, AG-004. Tests were delivered against unimplemented exports. The conversation could not
make them pass, so at 20:36:21 it restored the file byte-exact to `HEAD` and ran a full `tsc` rebuild
to confirm a clean tree — nine minutes after reporting done, and nine minutes after a reviewer had
already read the failing state. The review described a tree that no longer existed.)*

Corollary — **you are done when you stop writing, not when you say so.** Do not touch the working
tree after your close-out report. A reviewer may already be reading it.

## 14. Service Verification (OmniRouter & External Services)
Whenever diagnosing HTTP status errors (like 429, 404, or 503) from a local gateway or service such as OmniRouter, **you must explicitly verify that the service process itself is running and listening on its expected port (e.g., `curl -s http://127.0.0.1:20128/health` or `lsof -i :20128`) before confirming the diagnosis.**
Do not assume that an HTTP 429 indicates the service is down; an active HTTP response means the service is alive but upstream credentials/rate limits are exhausted. Always check the service health locally before concluding why errors are occurring.
