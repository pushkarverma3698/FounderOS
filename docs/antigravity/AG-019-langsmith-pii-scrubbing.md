# AG-019 — LangSmith telemetry export: scrub PII before dispatch, not block it entirely

**Milestone:** issue #687 item 6
**Branch:** `task/issue-<N>-langsmith-pii-scrubbing` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ✅ CLOSED 2026-09-17 — already fixed, and fixed correctly on purpose. See "Verification
result" at the bottom — this brief's own premise ("the fix is to scrub, not block") turns out to
be infeasible with the installed SDK, and the existing fix chose the honest alternative.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Why this one needs care before writing code

Issue #687 named `src/telemetry/langsmith.ts` — **this file does not exist.** There is no
dedicated LangSmith integration file in this repo; the real candidates are `src/infra/telemetry.ts`
and `src/core/config.ts` (found by grepping for `langsmith`/`LANGCHAIN_TRACING`). It's plausible
LangSmith tracing here is just LangChain's standard `LANGCHAIN_TRACING_V2`/`LANGCHAIN_API_KEY` env
wiring rather than a bespoke integration — **confirm this before assuming a scrubbing middleware
needs to be built from scratch.**

Also confirm the actual failure mode before building anything: issue #687 says exports are "blocked
by safety filters due to unscrubbed PII" — is this LangSmith's own ingestion rejecting the payload,
or a local guard in this repo blocking the export? Those are different bugs with different fixes.

## Goal

Run I/O (prompts, tool inputs/outputs) currently dispatched to LangSmith for tracing may contain
PII (the founder's own data, jobhunt candidate data, credentials in tool args). **Done means:**
whatever leaves this repo for LangSmith has PII scrubbed first — not that tracing is disabled
entirely (tracing has real debugging value; the fix is to scrub, not to block).

## Measured starting state — verify before you begin

```bash
grep -n "langsmith\|LANGCHAIN_TRACING\|LANGCHAIN_API_KEY" src/infra/telemetry.ts src/core/config.ts
grep -rn "redactSecrets\|scrub" src/ --include="*.ts" | grep -v test
```

Note: `redactSecrets()` already exists and is used by `read_logs`
([[docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md]] Part 1's finding on
`src/tools/read-logs.ts`) — check whether it's reusable here before writing a new scrubber. Reusing
an already-reviewed redaction function is safer than a second bespoke implementation of the same
category of logic.

## Files in scope

| Path | Change |
|---|---|
| Whichever file actually owns LangSmith/tracing config (confirm first) | apply scrubbing to run I/O before it's dispatched |
| Existing redaction utility, if reusable | extend or call from the tracing path |
| `tests/unit/infra/` (matching existing location) | regression test: a payload with a fake secret/PII pattern is scrubbed before the traced payload is constructed |

## Explicitly forbidden

- Do not disable LangSmith tracing entirely as the fix — that's over-scoped relative to what was
  asked and removes real debugging value the founder didn't ask to give up.
- Do not build a second redaction implementation if `redactSecrets()` (or equivalent) already covers
  this — check first.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

## Verify

```bash
pnpm gate
```

Per rule #36: show a before/after of a traced payload containing a synthetic PII pattern, confirming
it's scrubbed in the after case, or say **NOT VERIFIED — reason**.

---

## Verification result (2026-09-17)

Read `src/infra/telemetry.ts` in full. This file's own header already documents this exact bug and
its fix: it used to claim a PII scrubber ran before export, and that claim was false (`scrubPii`/
`scrubObject` had exactly one consumer — the local pino log path — and were never attached to any
LangSmith exporter). That was found and fixed already, and fixed as a **refusal gate**, not a
scrubber:

- `decideExport()` is a pure function: no `LANGCHAIN_API_KEY` → no-op. Tracing requested with a key
  but no explicit opt-in → **refused**, and refusal is real (`TRACING_ENV_VARS` are deleted from
  `process.env`, not just logged, because LangChain reads those vars itself and would otherwise
  retry). Only with `LANGSMITH_ACCEPT_UNSCRUBBED_EXPORT=true` does export proceed — logged at
  `error` level every time, naming exactly what leaves the box.
- Confirmed **why** "scrub, don't block" (this brief's own instruction) isn't the fix: `langsmith
  0.2.15` exposes `anonymizer`/`hideInputs`/`hideOutputs` only as `Client` constructor options
  (`node_modules/langsmith/dist/client.d.ts:10-11`), and LangChain's auto-tracing path builds its
  own `Client` — there is no env-var or hook to scrub through. Reaching into LangChain tracer
  internals to inject a scrubbing client would be version-coupled and unprovable from outside a
  live trace. Blocking-by-default with an explicit, loud opt-in is the honest alternative given
  that constraint, not scope creep past the brief.
- Tests already exist and are real: `tests/unit/infra/telemetry-export-guard.test.ts`,
  `tests/unit/infra/telemetry-metadata.test.ts`.
- `redactSecrets()` (the reusable utility this brief pointed at) is correctly NOT used here — it
  scrubs local logs/traces, a different boundary from the third-party export gate.

**Verdict: no code change.** The existing fix is more correct than what this brief asked for
(refusal with a loud, specific reason beats a scrubber that langsmith 0.2.15 cannot actually
support), and it's tested. Confirmed `initTelemetry()` still runs once at startup before kernel
boot (`src/index.ts`), per the file's own ordering rule.
