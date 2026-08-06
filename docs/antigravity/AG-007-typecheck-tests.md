# AG-007 — Bring `tests/` under the same typecheck as `src/`

**Milestone:** cross-cutting (the drift lock's missing half)
**Status:** ready to dispatch
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

`pnpm lint` currently typechecks `src/` and `scripts/` but **not** `tests/` — `tsconfig.json` line 23
excludes `tests/**/*`. The consequence is that a test file can import functions that do not exist and
the lint gate still exits 0.

This is not hypothetical. On 2026-08-06 a delegated task delivered 16 tests importing five exports
that were never implemented; `pnpm lint` passed, and the failure was only found by a human reading
the diff. Two smaller instances of the same class are live in the tree right now
(`tests/unit/agents/model.test.ts` uses `beforeEach` without importing it).

**Done means:** `pnpm lint` fails if any file under `tests/` has a type error, and the current tree
passes it. After this change, "tests written against code that does not exist" is caught by CI
instead of by a reviewer's attention.

---

## Measured starting state — verify these numbers yourself before you begin

Run this first and confirm you reproduce it. If your numbers differ, **stop and report** — the tree
has moved and the brief is stale.

```bash
cat > /tmp/tsconfig.probe.json <<'EOF'
{
  "extends": "/Users/pushkarverma/Projects/founderos/tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*", "scripts/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist", "src/social-media-agent/**/*"]
}
EOF
npx tsc -p /tmp/tsconfig.probe.json --noEmit 2>&1 | grep -c "error TS"
```

| Measure | Value |
|---|---|
| Total errors | **109** |
| Errors in `tests/` | **109** |
| Errors in `src/` + `scripts/` | **0** |
| Distinct files affected | **34** |
| Worst single file | `tests/unit/kernel/worker-collect.test.ts` (11) |

Error mix: `TS2322` 17, `TS2339` 15, `TS7053` 13, `TS2532` 13, `TS2554` 10, `TS2493` 9, `TS2741` 7,
`TS2345` 7, `TS7006` 6, `TS2352` 4, and a long tail. Most are `noUncheckedIndexedAccess` friction —
array access returning `T | undefined` — not deep design problems.

**`src/` and `scripts/` are at zero and must stay at zero.**

---

## Files in scope

| Path | Change |
|---|---|
| `tsconfig.test.json` | **new** — extends the base config, adds `tests/**/*`, `noEmit: true` |
| `package.json` | `lint` script runs the new config as a second pass |
| `tests/**/*.ts` | fix the 109 type errors — test files only |

Nothing else. **`tsconfig.json` itself is not in scope** — do not edit it. `pnpm build` emits to
`dist/` from that config, and adding tests there would ship test files into the production build.

---

## The design (follow exactly — do not improvise an alternative)

**1. New `tsconfig.test.json` at the repo root:**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*", "scripts/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist", "src/social-media-agent/**/*"]
}
```

`src/` and `scripts/` stay in `include` deliberately: tests import from `src/`, and excluding it
would typecheck the tests against an incomplete program.

**2. `package.json` — extend `lint`, do not replace it:**

```json
"lint": "tsc --noEmit && tsc -p tsconfig.test.json"
```

**3. Fix all 109 errors in the test files.**

---

## How the errors must be fixed

**The test is what is wrong. Fix the test.** Every one of these is a test making an assumption the
type system cannot confirm.

| Error | Correct fix |
|---|---|
| `TS2532` / `TS18048` / `TS2493` — possibly undefined | Assert first: `expect(result[0]).toBeDefined();` then use `result[0]!`. Prefer a real assertion over a bare `!` where the test is checking that value anyway. |
| `TS7053` — implicit any from index signature | Type the lookup object, or narrow the key to a union. |
| `TS2322` / `TS2345` / `TS2741` — wrong/incomplete fixture shape | Complete the fixture to satisfy the real type. **If the fixture cannot satisfy it, that is a finding — report it, do not cast it away.** |
| `TS2554` — wrong argument count | Match the real signature. |
| `TS7006` — implicit any parameter | Annotate the parameter. |
| `TS2304` — cannot find name | Add the missing import (e.g. `beforeEach` from `vitest`). |

### Forbidden fixes — any of these fails review

- **`any`, `as any`, `@ts-ignore`, `@ts-expect-error`, or `eslint-disable`.** STANDARDS §1 forbids
  `any` and this task does not override it. A suppression converts a caught bug back into an
  uncaught one, which is the exact opposite of this brief's purpose.
- **Relaxing any compiler option** — `strict`, `noUncheckedIndexedAccess`, `noImplicitAny` all stay
  on. Turning `strict` off in the test config *adds* 46 errors in `scripts/`; it is not a shortcut,
  it is a different, worse problem. Measured, not assumed.
- **Editing anything under `src/`** to make a test compile. If a test cannot be typed without
  changing production code, that is a genuine finding: **stop and report it**, naming the file and
  the reason. Do not change `src/`.
- **Deleting, skipping, or `.todo`-ing a test** to remove an error.
- **Changing what a test asserts.** Behaviour must be identical before and after. If a fix would
  alter an assertion, stop and report.

---

## Work in batches of ~5 files

After each batch run the verify command. This keeps a mistake attributable to five files rather than
thirty-four, and it means a partial delivery is still useful.

If you get stuck on a file, **leave it failing and move on** — a report naming three unfixable files
is a good outcome. Per STANDARDS §13: never revert your own work to make the tree look clean.

---

## Verify command

Run this and **paste the raw output**, not a summary:

```bash
pnpm lint && pnpm test
```

Both must be green. `pnpm test` is in the verify command because a type fix can silently change
runtime behaviour — an added `!` is inert, but a "corrected" fixture shape is not.

Report:
1. Raw output of the verify command.
2. Count of errors fixed, and any file you could not fix, with the reason.
3. Anything you found that needed a `src/` change (which you did not make).
