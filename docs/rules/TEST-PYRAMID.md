# Test Pyramid (FounderOS)

Four tiers, each owning a named risk. The trace layer (`src/infra/trace.ts`) is the
oracle for the Seam tier.

| Tier | Owns | Where | Command | Gate |
|---|---|---|---|---|
| Unit | pure logic (guards, slicing, parsing, routing keywords) | `tests/unit/**` (non-gateway) | `pnpm test` | must-pass |
| Seam | run-loop ordered trace events (fake office) | `tests/unit/gateway/seam-trace.test.ts` | `pnpm test:seam` | must-pass |
| Contract | each tool's exact action + fields + soft-fail + no-audit-on-fail | `tests/unit/tools/**` | `pnpm test` | must-pass |
| Real-path | live MTProto over the real gateway | `scripts/*` via `scripts/qa.ts` | `pnpm tsx scripts/qa.ts <mode>` | advisory/manual |

**Merge gate:** `pnpm gate` (= `pnpm lint && pnpm test`) runs Unit + Seam + Contract
(deterministic — tsc + unit + regression, no network). The eval and any LLM/network
test (`pnpm test:integration`, `pnpm test:eval`) is ADVISORY — it never blocks merge
(non-deterministic at temp 0, per MEMORY.md). Run real-path QA before shipping
behaviour changes (CLAUDE.md rule #19).

**Why the Seam tier exists:** every production P0 (wedge-loop, reject-loop, stale-reply,
duplicate-instance) passed Unit+Contract but crossed a gateway seam no test asserted.
The Seam tier asserts the ordered seams of a turn (via `src/infra/trace.ts` as oracle),
so those regressions surface as a trace diff before merge. Negative-control proven:
commenting a seam emit fails the tier.

## Real-path QA modes (`scripts/qa.ts`)
- `pnpm tsx scripts/qa.ts suite`     → full founder-simulation (`scripts/e2e-telegram-qa.ts`)
- `pnpm tsx scripts/qa.ts send <t>`  → single send/approve (`scripts/telegram-tester.ts`)
- `pnpm tsx scripts/qa.ts probe <t>` → office-level probe (`scripts/probe-real-task.ts`)

All real-path modes need the one-time founder MTProto login (see `scripts/telegram-tester.ts login`).
