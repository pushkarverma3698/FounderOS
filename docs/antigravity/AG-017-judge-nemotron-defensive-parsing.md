# AG-017 — Judge service crash on Nemotron completions ("dead again")

**Milestone:** issue #687 item 4
**Branch:** `task/issue-<N>-judge-nemotron-parsing` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ready to dispatch pending founder go-ahead (not yet filed as a GitHub issue)

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
