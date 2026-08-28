# ADR-020 — Global kill switch (flag-file) + before-production hardening scope

- **Date:** 2026-06-12
- **Status:** Accepted
- **Branch:** `feat/production-hardening`

## Context

The founder supplied an 8-phase "Principal Production Architect" checklist
(`beforeProduction.docx`) — a generic enterprise hardening template — and asked to
implement it on a separate branch. Measured against FounderOS reality (a single-tenant,
single-instance Telegram bot with one founder-operator), ~60% was already shipped
(budget guard, Zod env validation, seam/trace + golden traces, `pnpm gate`, DB-backed
HITL + idempotency, LangSmith, secret redaction, single-instance lock) and a large
fraction was multi-tenant SaaS work that `ROADMAP.md` and the CLAUDE.md triple-filter
explicitly gate to **Phase-E**.

## Decision

**1. Scope = focused in-scope.** Build only the genuine gaps and document the rest
honestly. Do **not** build Phase-E SaaS items (per-user rate limits, SOC2, blue-green/
canary, pgbouncer, ELK/Datadog, on-call rotation, 10× load/chaos). Rationale: YAGNI +
the feature triple-filter (real outcome · closes a named hiring gap · mostly reuse).
Building SaaS theater for a one-user bot fails all three. The full mapping lived in
`PRODUCTION-HARDENING-TRIAGE-2026-06-12.md`, since removed; the surviving operational
detail is in [PRODUCTION.md](../PRODUCTION.md).

**2. Kill switch = flag-file, not Redis.** The prompt specified a Redis key
(`founderos:global:halt`). FounderOS marks Redis `[SaaS-PHASE: no boot dep]`. We back
the global halt with a **flag file** (`$HOME/.founderos/HALT`, override `HALT_FLAG_PATH`)
where presence = halted. Reasons:
- No new boot/runtime dependency on the hot path; can't **fail-open** if a cache is down.
- Fits the single-instance (PID-locked) reality — a local file is authoritative.
- Fail-safe: a present-but-corrupt flag is still treated as halted; a transient non-ENOENT
  read error is logged loudly and treated as not-halted so a flaky FS can't brick the bot.

**3. Halt blocks new turns AND approval resumes, not in-flight runs.** The gate runs at
gateway entry (`runOfficeText` + `resumeOffice`, emitting the `halt.blocked` seam). It
refuses new work and approval taps before any side effect, but does not abort a task
already mid-LLM-call. Turns are seconds-long and the per-run budget guard caps runaway
loops, so a turn-entry check is the pragmatic stop for a single-instance bot. This
limitation is stated plainly to the founder and in `PRODUCTION.md` — not overclaimed.

## Consequences

- New: `src/infra/halt.ts`, `/halt` `/resume` commands, `halt.blocked` seam, 17 tests.
- New docs: `PRODUCTION.md`, `SEAM-FAILURES.md`, `rules/CODE-REVIEW-CHECKLIST.md`,
  `.github/pull_request_template.md`, the triage report, this ADR.
- To fully stop an in-flight run: `/halt` then restart the process (state is
  checkpointed — no data loss).
- Branch-protection rule + standardized issue labels are recorded as policy in the
  triage doc; enabling them is a one-click GitHub repo setting (not code).

## Alternatives rejected

- **Redis-backed halt** — adds a boot dependency and a fail-open risk for no benefit on a
  single-instance bot.
- **In-flight abort (cancel the running graph)** — high complexity, low value for
  seconds-long single-user turns; the budget guard already bounds worst-case spend.
- **Implement the whole checklist** — violates ROADMAP Phase-E gating and the
  triple-filter; mostly theater for one user.

Related: [[017-bounded-conversation-history]], [[019-engine-swap-claude-code-executor]],
[[011-portfolio-as-product-and-eval-harness]].
