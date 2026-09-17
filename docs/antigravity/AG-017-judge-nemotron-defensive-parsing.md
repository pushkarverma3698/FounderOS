# AG-017 — Judge service crash on Nemotron completions ("dead again")

**Milestone:** issue #687 item 4
**Branch:** `task/issue-<N>-judge-nemotron-parsing` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ✅ FIXED 2026-09-17 — see "Verification result" at the bottom.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Why "dead again" matters

[docs/sessions/2026-09-16-fallback-chain-starvation.md](../sessions/2026-09-16-fallback-chain-starvation.md)
Outstanding #4, same day, independently: *"The judge model is dead again —
`openrouter:nvidia/nemotron…` threw `Cannot read properties of undefined (reading 'message')`."*
The word "again" means this has happened before. Before fixing the immediate crash, check git
history/memory for a prior fix to the same symptom — if one exists and didn't hold, the defensive
parsing needs to be more general than a single null-check, or the *cause* of the undefined property
needs root-causing (a schema change on OpenRouter's side? a provider-specific response shape this
parser never handled?), not just patched again.

## Goal

`src/infra/judge-model.ts` (confirmed real file — issue #687 named `src/eval/judge.ts`, which does
not exist in this repo) crashes with `Cannot read properties of undefined (reading 'message')` when
processing a response from the OpenRouter Nemotron model. **Done means:** the judge handles a
malformed/unexpected Nemotron response shape without crashing — either a defensive parse with a
fallback default, or (preferably, given "again") a fix to whatever upstream assumption about the
response shape is wrong.

## Measured starting state — verify before you begin

```bash
grep -n "message\b" src/infra/judge-model.ts src/infra/judge-health.ts
# Reproduce: find or construct a Nemotron response shape that triggers the crash
grep -rn "nemotron" src/ tests/
```

Check `docs/sessions/*.md` and the memory index for any prior "judge model" or "Nemotron" fix — if
one exists, read it before writing new code, and say in the PR whether this is a recurrence of that
exact fix not holding, or a new failure mode.

## Files in scope

| Path | Change |
|---|---|
| `src/infra/judge-model.ts` | defensive parsing / root-cause fix for the undefined `.message` access |
| `src/infra/judge-health.ts` | if this is where the health check reports judge status, make sure a crash here doesn't get reported as healthy (cross-reference [[docs/plans/2026-09-16-mechanism-fail-open-silent-defaults.md]] — a judge health check silently reporting "fine" while the judge is dead is exactly that failure shape) |
| `tests/unit/infra/` (matching existing location) | regression test using the actual malformed response shape you find |

## Explicitly forbidden

- Do not add a blanket `try/catch` that swallows the error and returns a default "pass" or neutral
  judge score — a judge that silently stops judging is worse than one that visibly crashes. If the
  Nemotron response can't be parsed, the judge result for that item should be reported as
  unavailable, not defaulted to a value that looks like a real judgment.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

## Verify

```bash
pnpm gate
```

Per rule #36: reproduce the exact crash with a real or realistic Nemotron response and show it no
longer crashes, or say **NOT VERIFIED — reason** if reproduction wasn't possible.

---

## Verification result (2026-09-17)

Checked git history first, per this brief's own instruction: `src/infra/judge.ts` already carried
fix #1 (2026-09-14, PR #675) — an `instanceof Error` check preventing the crash. It held. The
recurrence named in `docs/sessions/2026-09-16-fallback-chain-starvation.md` had two independent
causes, neither a failure of fix #1 itself:

1. **`scripts/lib/content-judge.ts` never got fix #1.** Its `judgeReply()` catch block still did the
   exact unsafe `(err as Error).message` cast — a second, un-generalized copy of the same bug.
2. **A genuine, different root cause fix #1 correctly avoided crashing on, but reported unhelpfully.**
   Confirmed against the installed `@langchain/core@1.1.49`: `BaseChatModel.invoke()` does
   `generatePrompt(...).generations[0][0].message` with no bounds check. `@langchain/openai`'s
   `_generate()` legitimately returns `generations: []` for a free-tier model that rate-limits,
   content-filters, or exhausts its token budget on hidden reasoning — a real, expected shape, not a
   parsing defect. `[][0]` is `undefined`, `.message` on that throws the identical TypeError text,
   except this one is a genuine `Error` instance from library-internal code. Fix #1's `instanceof
   Error` check correctly didn't crash on it, but passed the raw opaque string straight through —
   indistinguishable from a real code defect to anyone reading the alert.

**Fix:** `errorMessage()` in `src/infra/judge.ts` now recognizes that exact signature and returns a
legible reason ("judge model returned zero completions — typically rate-limiting, content
filtering, or a reasoning budget exhaustion, not a parsing defect") instead of the opaque engine
string; exported so `content-judge.ts` imports the same function instead of a second copy.
`judgeReply()` gained an optional injectable-model test seam (mirroring `judge.ts`'s existing
`opts.model` pattern) so this is unit-testable without a network call.

**Bonus fix found while testing:** `errorMessage(undefined)` returned the actual JS value
`undefined` (not the string `"undefined"`) because `JSON.stringify(undefined)` returns `undefined`
at runtime despite being typed `string` — a latent hole in the function's own "never throws, always
a string" contract, present since the 2026-09-14 fix. Now falls back to `String(err)`.

**Verify:**
```
$ npx vitest run tests/unit/infra/judge.test.ts tests/unit/scripts/content-judge.test.ts
 Test Files  2 passed (2)
      Tests  27 passed (27)

$ pnpm gate
 Test Files  399 passed (399)
      Tests  4460 passed (4460)
```
Reproduced with the exact real signature (`"Cannot read properties of undefined (reading
'message')"`) as a genuine `Error` instance in both `judge.test.ts` and `content-judge.test.ts` —
this is the realistic Nemotron/zero-completions shape, per rule #36. A live forced reproduction
(deliberately starving OpenRouter's free tier to trigger a real zero-choices response) was not
attempted — that would require burning real rate-limit budget to force a flaky condition on
purpose, disproportionate to what the unit-level reproduction already proves.
