# FounderOS — Code Review Checklist

Adapted to FounderOS reality (single-tenant Telegram bot, seam-traced run-loop,
DB-backed HITL). Run through this before merging any PR. Pairs with
[`TESTING-RULES.md`](TESTING-RULES.md) and [`PROGRAMMING-RULES.md`](PROGRAMMING-RULES.md).

## Correctness & safety

- [ ] `pnpm gate` is green (tsc + full vitest suite).
- [ ] Behaviour-affecting change (prompt / tool / model / routing) checked against
      `pnpm eval` — golden routing/tool/HITL set not regressed.
- [ ] HITL gate fires for every **external** side effect (email, LinkedIn, GitHub
      write, file write, send_file). Internal analysis/draft steps are **not** gated.
- [ ] Idempotency guard (`hasBeenAudited` / `writeAuditEntry`) precedes every external
      send; the audit row is written **only on real success** (no phantom-success).
- [ ] Errors **fail loud** — surfaced to the founder on Telegram, never a silent
      swallow or a generic "✅ Done." that hides a failure.

## Observability

- [ ] No `console.log` in `src/` (process-boot `console.error` in `index.ts`/`mcp` is
      the only allowed exception). Use the `logger` child + `trace.event()`.
- [ ] New run-loop branches emit a seam (`trace.event(...)`) so a turn is greppable by
      `turnId`.
- [ ] New seam name added to the `Seam` union in `src/infra/trace.ts` if introduced.

## Security

- [ ] No hardcoded secrets — keys come from env, validated in `src/core/config.ts`.
- [ ] User/external input validated at the boundary (Zod / explicit checks); no
      `as any` on raw API responses.
- [ ] Error messages are founder-safe — no stack traces or secret values leaked into a
      reply (see `redactSecrets` / `scrubObject`).

## Determinism & tests (CLAUDE.md #16, #19)

- [ ] Logic that can be a pure function (routing, slicing, guards, parsing, formatting)
      **is** one, with a unit test — not a prompt instruction the model may ignore.
- [ ] Every fixed bug has a regression test on the **real** code path (gateway loop,
      not just the invoker).
- [ ] Temperature stays 0 by default (no non-zero default sampling).

## Cost (single-tenant)

- [ ] Cost-sensitive paths run under the per-run budget guard
      (`RUN_BUDGET_USD` / `RUN_BUDGET_TOKENS`); a new long loop respects
      `OFFICE_RECURSION_LIMIT`.

## Docs & memory

- [ ] "Why" comments on non-obvious functions (business reason, when called, failure
      mode) — not just "what".
- [ ] Architectural decision recorded in `docs/decisions/` and queued for
      `pnpm brain:sync`; `MEMORY.md` updated for the next session.
