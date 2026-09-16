# Mechanism fix — synthetic fallback-chain health check

**Theme:** 7 — model-fallback chain fragility, 5 independent instances, same subsystem July→today
([docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md](2026-09-16-recurring-failure-patterns-and-behavior-audit.md))
**Status:** implementation plan, not yet built

## Problem

`withModelFallbacks()` (`src/gateway/model-fallback.ts`) is real, and PR #683 (2026-09-16) fixed a
genuine arithmetic bug in it — the primary raced against the whole resolution budget, so the chain
could only ever engage in the one case that didn't need it. That bug was live for roughly its whole
~2-month life, undetected, because **nothing exercises the fallback path outside a real provider
outage.** The chain is also currently 2 deep, not the intended 4, because two configured OpenRouter
slugs 404 as unavailable on the free tier — also only discoverable by someone hitting it live.

## Approach

A small script, run on a schedule (VPS cron, e.g. every 6h — matching the cadence of other
maintenance crons in this repo), that specifically exercises the *chain-selection logic*, not just
model reachability:

1. Call `withModelFallbacks()` (or the resolution function it wraps) with a primary forced to fail
   immediately (a test double / a deliberately-invalid primary config), so the real code path that
   selects and races fallbacks actually runs — this is what a naive "ping each model directly" check
   would miss, since it wouldn't exercise the chain logic itself, only model reachability.
2. Record which fallback index actually answered, and how long each configured model took to fail
   or respond.
3. Alert (Telegram, matching this repo's existing alerting patterns) if: no fallback answers at all,
   any configured slug consistently fails (candidate for removal/replacement), or the chain's
   effective depth (live, reachable fallbacks) drops below a configured minimum.

This would have caught the arithmetic bug far earlier than 2 months (the very first scheduled run
after it was introduced would have shown "no fallback answered" against a forced-failing primary),
and continuously catches the "2 deep not 4" gap going forward.

## Files likely in scope

- new script, e.g. `scripts/check-fallback-chain-health.ts`
- VPS crontab entry (alongside existing maintenance cron entries)
- a small results table or reuse of existing health-check infra (`src/infra/health.ts`,
  `src/infra/provider-probes.ts` — check if either already fits before adding a new table)

## Out of scope

- Not attempting to add more fallback models as part of this — that's a separate, cost-bearing
  decision (more free-tier slugs to manage) the founder should make deliberately.
- Not wiring this into `pnpm gate` (it makes real network calls, however trivial — this is a
  scheduled operational check, not a merge gate, per this repo's "Zero paid calls in the dev loop"
  discipline where applicable, and to avoid CI flakiness from provider hiccups).

## Verify

```bash
node --import tsx/esm scripts/check-fallback-chain-health.ts --force-primary-fail
```
Should report which fallback answered and confirm the forced-failure path actually exercises
`withModelFallbacks()`'s real selection logic, not a mock.

## Next step

Turn into an AG-NNN dispatch brief once prioritized.
