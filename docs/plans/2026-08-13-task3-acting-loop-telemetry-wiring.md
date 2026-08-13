# Task 3 — Wire the telemetry analyzers into the acting loop

**Date:** 2026-08-13 · **Branch:** `claude/founderos-remediation-plan-st8oal`
**Prerequisites:** Task 1 (occurrence axis, PR #472) and Task 2 (findings persistence, PR #471), both merged to `main` at `d9d0a67`.

## Outcome this serves

The founder gets a self-audit every 3 days that (a) actually arrives, (b) says
which findings are **new** and which were **fixed and came back**, and (c) never
renders a sensor that did not run as a sensor that came back clean.

## What was actually wrong (measured, not assumed)

Three defects, found by tracing the cron path rather than the CLI path. The
acting loop is `startScheduler` → `runSelfAuditSweep` (every 3 days, 08:00) →
`runSelfAudit()` → Telegram. The CLI (`pnpm audit:self`) is a *different* code
path, and every existing guarantee lived only in the CLI half.

### D1 — the founder's message is unsendable the moment telemetry finds anything (high)

`src/evolution/audit-sweep.ts:17` calls `sendToChat(report, "HTML")`. Nothing
escapes the report. `normalizeFailureSignature` (`src/kernel/lessons.ts:56`)
deliberately rewrites volatile tokens as `<n>`, `<uuid>`, `<hash>`, `<url>`,
`<email>`, `<payload>` — and those signatures are copied verbatim into the
`subject` and `evidence` of every `findUnappliedLessons` /
`findRecurringFailures` finding.

Measured, by running the real analyzers and the real renderer over a realistic
signature:

```
RAW SIGNATURE : "tool gmail_send failed after <n> attempts (status <n>) for user <uuid>"
TAG-LIKE TOKENS  : ["n","uuid"]
NOT WHITELISTED  : ["n","uuid"]
```

Telegram's Bot API accepts a fixed tag whitelist and rejects anything else with
`400 Bad Request: can't parse entities`. **That rejection is reasoned from the
documented Bot API contract — it was NOT executed against Telegram from this
container.** The rest of the chain above is measured.

Effect: `sendToChat` throws → the catch at `audit-sweep.ts:19` logs
`"Self-audit sweep error (non-fatal)"` → the founder receives **nothing**, every
3 days, silently. This is latent today (it needs telemetry to produce ≥1
finding) and Task 1 made it substantially more likely, because before the
occurrence axis `failure_lessons` only held resolution rows.

Note the three sibling senders — `src/infra/halt.ts:118`,
`src/infra/scheduler.ts:221`, `src/infra/rag-optimization-sweep.ts:38` — each
define a local `escapeHtml`. `audit-sweep.ts` is the only one that does not.

### D2 — "telemetry did not run" renders as "telemetry came back clean" (high)

`scripts/audit-self.ts:104-109`:

```ts
export async function runSelfAudit(): Promise<string> {
  const staticFindings = runStaticAnalyzers();
  const telemetry = await runTelemetryAnalyzers();          // { findings, skippedReason }
  const ranked = rankFindings([...staticFindings, ...telemetry.findings]);
  return renderReport(ranked);                              // skippedReason DROPPED
}
```

`main()` (the CLI, lines 119-127) prints a loud `TELEMETRY SKIPPED — … This is
not a clean result, it is no result.` The cron path discards the same field. So
with Postgres unreachable the founder's message reads
`Self-audit: 14 findings (…)` with zero telemetry findings — indistinguishable
from telemetry having run and found nothing.

This is the exact defect named in the header of
`tests/unit/infra/self-improvement-wiring.test.ts:11` as though it were fixed.
It was not: that file only ever tested the RAG sweep half, and `runSelfAudit`
has no test at all.

### D3 — Task 2's persistence has zero production callers (high)

`persistFindingsForRun` is complete and carries 12 test cases, but
`grep -rn "persistFindingsForRun" src/ scripts/` returns **only** its own
definition and its tests. `evolution_findings` and `evolution_runs` — shipped in
PR #471, migrated onto prod at deploy `31673815467` — never receive a row.
Recurrence, regression detection and `times_seen` across runs are all inert.

## Design

### One orchestration path (kills the CLI/cron divergence at the root)

D2 exists because the CLI and the cron are two renderers over one collector, and
only the CLI was maintained. New module `src/evolution/run-audit.ts` becomes the
single orchestration path; `scripts/audit-self.ts` (CLI) and
`src/evolution/audit-sweep.ts` (cron) both consume it. This also removes the
backwards `src/ → scripts/` dynamic import at `audit-sweep.ts:15`.

`runSelfAudit()` returns findings **grouped per analyzer**, not flattened,
because that grouping *is* the run's coverage and coverage is what
`persistFindingsForRun` needs to tell "fixed" from "the analyzer never ran".

### The critical invariant

When telemetry is skipped, the telemetry analyzers must be **absent** from
`analyzerResults` — never present with `findings: []`. Passing them empty would
mark every previously-open telemetry finding `resolved`, writing D2's lie
permanently into the database. Pinned by a test.

### Feature flag

`EVOLUTION_PERSIST_FINDINGS`, default OFF (`src/core/config.ts`, matching the
`SKILL_SYNTHESIS_ENABLED` pattern; read at call time so tests can flip it).

Gated: **database writes only**. Not gated: the D1 escaping fix and the D2
honesty fix. A flag whose OFF state preserves "the report silently fails to
send" or "a skipped sensor reads as clean" would be a flag defaulting to the
bug. Rule 6 says fix the claim, and an honesty fix is not a behaviour change to
be rolled out — it is the removal of a false statement.

### Acting-on-it (rule #26)

The report gains a delta line and, when non-empty, a REGRESSED section listing
findings that were resolved and have come back. A regression is the highest
-signal row in the whole audit and is currently invisible. Absent persistence
(flag OFF or store outage) the line says so rather than printing zeros.

## Out of scope

Task 6 (scheduling changes) and Task 0 (the prod benchmark baseline) are
untouched. The cron cadence is not modified by this task.
