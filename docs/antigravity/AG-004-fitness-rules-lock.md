# AG-004 — Five new architecture fitness rules (the drift lock)

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Standards:** read **[`docs/antigravity/STANDARDS.md`](STANDARDS.md)** in full first. It is binding
and governs everything this brief does not explicitly override.
**Design:** `docs/superpowers/specs/2026-08-06-lock-code-practices-design.md` (approved)

---

## Goal

`scripts/verify-architecture.ts` is the only mechanism in this repo that has actually prevented
architectural decay — five fitness functions, a ratchet that may only shrink, tombstones that
hard-fail. Documentation has drifted; this file has not.

Add **five more rules** to it, each with an escape-hatch tag, so that practices learned the
expensive way become build failures instead of review opinions.

"Done" means: five rules implemented as pure functions matching the existing five, wired into
`runAllRules()`, baselines added to `governance/architecture-baseline.json`, tests added, and the
verify command below green.

---

## Read this first — the pattern to follow

**`scripts/verify-architecture.ts`** (254 lines) and **`tests/unit/scripts/verify-architecture.test.ts`**
(132 lines). Read both fully. Copy their shape exactly:

- A rule is `export function ruleX(files: Array<{rel: string; text: string}>): RuleResult`. Pure.
  No I/O inside a rule except where the rule is *about* file existence (see `doc-claims-ci` below,
  which follows the precedent already set by `ruleTombstones`).
- `RuleResult` = `{ rule: string; violations: Violation[] }`;
  `Violation` = `{ rule, file, detail }`. `detail` is legible on its own — include the line number
  and a trimmed excerpt, exactly like `ruleFailOpenCatch` does.
- Add each rule to the array returned by `runAllRules()`.
- `FROZEN` trees (`apps/`, `client/`, `Github/`) are excluded by `srcFiles()` already — use it.

---

## The escape-hatch tag (applies to all five rules)

A violation is suppressed if the offending line **or the line directly above it** contains
`allow-<rule-id>:` followed by **at least one non-whitespace character**.

```ts
// allow-explicit-any: drizzle returns an untyped row shape at this boundary
const row = result as any;
```

- `// allow-explicit-any: reason here` → suppressed.
- `// allow-explicit-any:` with nothing after the colon → **NOT suppressed**. A bare tag is a bypass,
  not an exception, and the whole point of the design is that every escape carries a reason.
- Implement this once as a shared helper (for example `isTagged(lines, index, ruleId)`) and use it
  from all five rules. Do not copy the check five times.

`ruleFailOpenCatch` already does a simpler version of this inline. **Do not change `ruleFailOpenCatch`**
— its baseline is pinned at 11 and any behaviour change there breaks the gate.

---

## The five rules

### 1. `analyzer-purity`

**Scope:** files whose path starts with `src/evolution/analyzers/`.
**Flags:** an import whose specifier is `node:fs`, `node:path`, `fs`, or `path`, **or** which
resolves (via the existing `resolveImport`) to a path starting with `src/db/`.
**Why:** the entire M0a sensor design depends on analyzers being pure so the self-audit runs in CI
at $0 and returns the same answer twice. An analyzer that reads a file destroys both properties.
**Measured baseline: 0.**

### 2. `text-reachability`

**Scope:** files whose path starts with `src/evolution/analyzers/`.
**Flags:** any line containing `.includes(`.
**Why — read this, it is the most expensive mistake in this repo's history:** reachability must be
computed from resolved import specifiers, never from raw file text. Substring matching has produced
**five** wrong answers: three in the 2026-08-06 hand audit (a doc comment merely *mentioning*
`src/outreach/graph.ts` made a dead subsystem look alive), and two more in AG-001
(`src/outreach/graph.ts` looked tested because a test imported `src/kernel/graph.js`;
`src/kernel/worker.ts` looked tested because a test mentioned `src/kernel/worker-utils`). Both were
**false negatives** — silent, so the untested module simply vanished from the audit.

Yes, this rule is blunt: a legitimate `.includes(` on a plain string array in an analyzer will trip
it. That is intended. Tag it with a reason and move on.
**Measured baseline: 0.**

### 3. `doc-claims-ci`

**Scope:** every `*.md` file in the repo, excluding `node_modules/` and any path segment starting
with `.` (except that `.github` references *inside* the text are the thing being checked).
**Flags:** a reference matching `.github/workflows/<name>.yml` where that file does not exist on
disk.
**Why:** `.cursorrules` claimed for three weeks that git policy was "CI-enforced by
`.github/workflows/branch-policy.yml`". That workflow was deleted 2026-08-01. A document telling an
agent "CI protects you" when it does not is worse than no document.
**Measured baseline: 1** — the `.cursorrules` reference. **AG-005 removes it. Pin the baseline at 1
in this brief;** do not edit `.cursorrules` yourself, it is out of scope and another task owns it.

This rule needs `existsSync`, which is fine — `ruleTombstones` already sets that precedent. Give it
the signature `ruleDocClaimsCi(root?: string): RuleResult` so tests can point it at a fixture
directory, exactly as `ruleTombstones(root)` does.

### 4. `no-explicit-any`

**Scope:** `src/` (via `srcFiles()`).
**Flags:** a line matching `/:\s*any\b|as\s+any\b|<\s*any\s*>|,\s*any\s*>/` **that is not a comment
line** — skip any line whose trimmed form starts with `//`, `*`, or `/*`.
**Why the comment exclusion is not optional:** measured without it, the rule reports 14 violations,
of which **4 are prose in doc comments** ("returns false on any error", "any fatal problem"). A rule
that fires on comments trains the reader to reach for the escape hatch reflexively, which converts
the tag from a signal into noise.
**Measured baseline: 10**, across 8 files: `src/kernel/lessons.ts` (2),
`src/infra/context-manager.ts` (2), and one each in `src/tools/artifact.ts`, `src/mcp/server.ts`,
`src/kernel/contracts.ts`, `src/infra/providers/google-direct.ts`, `src/infra/composio.ts`,
`src/agents/agent-tools/external-mcp.ts`.

**Do not fix the 10 existing violations.** They are pinned and ratchet down over time. Fixing them
is a separate task with its own review.

### 5. `no-console-log`

**Scope:** `src/` (via `srcFiles()`).
**Flags:** a line containing `console.log(` or `console.debug(`, excluding comment lines by the same
rule as above.
**Note:** `console.error` and `console.warn` are **allowed** — they are legitimate fail-loud
signalling, and `verify-architecture.ts` itself uses them.
**Measured baseline: 0.**

---

## Baselines — read carefully

`checkRatchet` treats a **missing** baseline key as 0 (there is a test asserting this: *"treats a
missing baseline entry as zero (new rules start strict)"*). So `no-explicit-any` **must** be added
to `governance/architecture-baseline.json` explicitly or CI fails immediately.

Add these five keys, preserving the existing five untouched:

```json
"analyzer-purity": 0,
"text-reachability": 0,
"doc-claims-ci": 1,
"no-explicit-any": 10,
"no-console-log": 0
```

**Do NOT run `--update-baseline`.** It overwrites the whole file from a live measurement, which
would silently re-pin the existing five rules to whatever the tree happens to contain while other
work is in flight. Edit the JSON by hand.

**If your own measurement of any rule differs from the number above, STOP and report the difference
with the offending file list. Do not pin your measurement silently.** A baseline that quietly
absorbs someone else's in-flight work is worse than a failing build.

---

## Required tests — `tests/unit/scripts/verify-architecture.test.ts`

Append to the existing file; keep every existing test exactly as-is. Follow the existing style
(fixture arrays of `{rel, text}`, one `describe` per rule).

Per rule (5 rules × 3 tests = 15):
1. **True positive** — a fixture that violates it, asserting exactly one violation.
2. **True negative** — a near-miss that must NOT flag. Specifically:
   - `analyzer-purity`: an analyzer importing `../types.js` → no violation.
   - `text-reachability`: a file **outside** `src/evolution/analyzers/` using `.includes(` → no violation.
   - `doc-claims-ci`: a doc referencing a workflow that **does** exist → no violation.
   - `no-explicit-any`: a line reading `// returns false on any error` → no violation (this is the
     comment-exclusion test, and it is the one that matters).
   - `no-console-log`: `console.error(...)` and `console.warn(...)` → no violation.
3. **Tag suppression** — the same violating fixture with `// allow-<rule-id>: reason` on the line
   above, asserting zero violations.

Plus **one** shared test, and it is the most important one in this file:
16. **A reason-less tag does not suppress.** Fixture with `// allow-explicit-any:` (nothing after
    the colon) above a violating line → still exactly one violation.

---

## Explicitly forbidden — task-specific

General rules are in [STANDARDS.md](STANDARDS.md) and apply in full. Task-specific:

- **Do not** modify `ruleFailOpenCatch`, `ruleGatewayImports`, `ruleKernelPurity`, `ruleLocBudget`,
  `ruleRegexRouting`, `ruleTombstones`, `checkRatchet`, `resolveImport`, `importsOf`, or the
  `TOMBSTONES` / `FROZEN` arrays. Their baselines are pinned; a behaviour change breaks the gate.
- **Do not** run `--update-baseline`.
- **Do not** fix any of the 10 existing `no-explicit-any` violations, or add tags to them.
- **Do not** edit `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` — another task owns those
  files and editing them here causes a conflict.
- **Do not** touch anything under `src/evolution/` — a third task owns it.
- **Do not** exceed 400 lines in `scripts/verify-architecture.ts`. It is at 254 now; five rules plus
  a shared tag helper must fit. If you approach the limit, say so in your report rather than
  compressing the code into unreadable one-liners.

---

## Verify

Run this exact command and **report its raw output in full**, including any failures:

```bash
cd /Users/pushkarverma/Projects/founderos && npx vitest run tests/unit/scripts/verify-architecture.test.ts && pnpm lint && pnpm verify:arch
```

Expected: all tests green; `tsc --noEmit` silent; `verify:arch` prints "Architecture gates green"
with **ten** rule lines, the original five unchanged at their baselines
(`gateway-imports 0 · kernel-purity 0 · fail-open-catch 11 · loc-budget 5 · regex-routing 0`) and
the five new ones at `0 · 0 · 1 · 10 · 0`.

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human reads `git diff` in full and re-runs verify before this is accepted. Report the raw verify
output and stop — do not summarize the work as "done".
