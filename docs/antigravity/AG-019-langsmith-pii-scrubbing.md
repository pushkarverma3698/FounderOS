# AG-019 — LangSmith telemetry export: scrub PII before dispatch, not block it entirely

**Milestone:** issue #687 item 6
**Branch:** `task/issue-<N>-langsmith-pii-scrubbing` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ready to dispatch pending founder go-ahead (not yet filed as a GitHub issue)

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
