# AG-002 — Fix false negatives in `findUntestedModules`

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Milestone:** M0a — Evolution Engine v0
**Supersedes:** the matching rule specified in AG-001 §2, which was wrong

---

## Goal

`findUntestedModules` in `src/evolution/analyzers/code-health.ts` currently decides whether a module
is tested by searching **raw test-file text** for two substrings. Raw-text matching produces silent
false negatives: a module that has no tests is reported as tested, so it never appears in the audit.
Two cases are confirmed by probe, both returning 0 findings where the correct answer is 1.

Your job is to replace the substring matching with **resolved import specifiers**, and to add tests
that lock both confirmed false negatives shut.

"Done" means: the matching rule is specifier-based, the two probe cases below produce exactly one
finding each, all pre-existing tests still pass, and the verify command below is green.

---

## The two confirmed defects

### Defect 1 — basename collision across directories

```ts
src   = [{ path: "src/outreach/graph.ts", text: "export const g = 1;" }]
tests = [{ path: "t.test.ts", text: 'import { x } from "../../src/kernel/graph.js";' }]
```

Correct answer: **1 finding** (`src/outreach/graph.ts` is untested).
Current answer: **0 findings** — the `/${basename}.js` rule matches `/graph.js`, which belongs to a
completely different module in a different directory.

This is not hypothetical. `src/outreach/graph.ts` and `src/kernel/graph.ts` both exist in this repo,
and `src/outreach/` is a known-orphaned subsystem — exactly the thing the sensor must catch.

### Defect 2 — path-prefix collision

```ts
src   = [{ path: "src/kernel/worker.ts", text: "export const w = 1;" }]
tests = [{ path: "t.test.ts", text: 'import { u } from "src/kernel/worker-utils";' }]
```

Correct answer: **1 finding** (`src/kernel/worker.ts` is untested).
Current answer: **0 findings** — `"src/kernel/worker-utils"` contains `"src/kernel/worker"` as a
substring, so a sibling module's test marks this one tested.

---

## Read this first — the pattern to follow

**`src/evolution/analyzers/dead-code.ts`** already solves this exact problem correctly. Read it
fully before writing anything. Specifically:

- `IMPORT_SPEC_RE` — extracts the quoted specifier from `import`/`export … from "…"` statements
  instead of scanning the whole file body.
- `resolveImport(fromPath, spec)` — walks `.` and `..` segments and strips a trailing `.js` to turn
  a relative specifier into a repo-relative module path.

**Reuse this approach.** `resolveImport` is currently local to `dead-code.ts`; export it from there
and import it into `code-health.ts` rather than writing a second copy. One resolver, one behaviour.

The governing rule, learned the expensive way during the 2026-08-06 audit and now binding on every
analyzer in this directory:

> **Reachability is computed from resolved import specifiers, never from raw file text.**
> A comment, a doc string, or a similarly named sibling that merely *mentions* a path must never
> make a module look reachable.

---

## Files in scope

**Modify exactly these three files. Touch nothing else.**

| Path | Change |
|---|---|
| `src/evolution/analyzers/dead-code.ts` | **Only** add `export` to the existing `resolveImport` function. Change nothing else in this file. |
| `src/evolution/analyzers/code-health.ts` | Rewrite `findUntestedModules` per the rule below. Leave `findOversizedPrompts` and `findFilesNearLocBudget` untouched. |
| `tests/unit/evolution/code-health.test.ts` | Add the two regression tests. Keep every existing test as-is. |

---

## The new matching rule

A `src` module counts as **tested** if and only if some test file contains an import or export
statement whose specifier, once resolved relative to that test file's own path, equals the module's
path with the `.ts` extension removed.

- Resolve every specifier in every test file once, into a `Set<string>` of resolved module paths.
  Do not re-resolve per module — that is O(modules × tests) for no reason.
- A module is tested iff its extension-stripped path is a member of that set.
- Non-relative specifiers (bare package names such as `vitest`) resolve to `null` and are skipped —
  `resolveImport` already returns `null` for these.
- Test-file paths in this repo are repo-relative (`tests/unit/evolution/code-health.test.ts`), and
  their specifiers are relative (`../../../src/evolution/analyzers/code-health.js`). Resolution must
  therefore yield `src/evolution/analyzers/code-health`.

**Keep the existing skip rules exactly as they are:** skip any file whose basename is `index`, and
skip any file under `src/db/` whose basename is `schema`.

**Keep the existing `Finding` shape exactly as it is:** `kind: "untested-module"`,
`severity: "low"`, `subject` and `location` both the module path. Only the evidence wording may
change, and only if it stays legible to someone who has never read the code.

---

## Required tests

Add both of these to `tests/unit/evolution/code-health.test.ts`, inside the existing
`describe("findUntestedModules", …)` block:

1. **`"does NOT treat a same-named module in another directory as coverage"`** — Defect 1 above.
   Assert exactly one finding, with `subject === "src/outreach/graph.ts"`.
2. **`"does NOT treat a path-prefix sibling as coverage"`** — Defect 2 above.
   Assert exactly one finding, with `subject === "src/kernel/worker.ts"`.

Both must **fail against the current implementation** and pass after your change. Confirm that by
running them before you edit `code-health.ts`; if they pass beforehand, your fixture is wrong.

The existing test `"does NOT flag a module referenced by /<basename>.js"` encodes the broken rule.
**Update its fixture** so the test file's specifier resolves to the module under test — that is,
give the test file a realistic path such as `tests/unit/kernel/worker.test.ts` and the specifier
`"../../../src/kernel/worker.js"`. Do not delete the test; it should still assert zero findings.

---

## Explicitly forbidden

- **Do not** modify `src/evolution/types.ts`, `src/evolution/collect.ts`, `dead-code.test.ts`, or
  `acceptance-rederive.test.ts`.
- **Do not** change anything in `dead-code.ts` other than adding the `export` keyword to
  `resolveImport`. Its analyzers and its own behaviour must be byte-for-byte unaffected.
- **Do not** change `findOversizedPrompts` or `findFilesNearLocBudget`.
- **Do not** write a second copy of the resolver. Import the one from `dead-code.ts`.
- **Do not** perform file I/O inside an analyzer — no `fs`, no `readFileSync`, no `path` reads.
- **Do not** add any npm dependency.
- **Do not** use `any`. Use `unknown` and narrow.
- **Do not** add `console.log`.
- **Do not** exceed 400 lines in any file.
- **Do not** change git branch, rebase, force-push, or open a PR.

---

## Verify

Run this exact command and **report its raw output in full**, including any failures:

```bash
cd /Users/pushkarverma/Projects/founderos && npx vitest run tests/unit/evolution/ && pnpm lint && pnpm verify:arch
```

All three parts must pass:
- vitest: all tests green, including `dead-code.test.ts` and `acceptance-rederive.test.ts`, which
  must **remain** green — they are the proof that `dead-code.ts` was not disturbed.
- `pnpm lint` (`tsc --noEmit`): no output means success.
- `pnpm verify:arch`: must print "Architecture gates green" with every count at baseline
  (`gateway-imports 0 · kernel-purity 0 · fail-open-catch 11 · loc-budget 5 · regex-routing 0`).

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human will read `git diff` in full and re-run the verify command before this is accepted. Report
the raw verify output and stop — do not summarize the work as "done".
