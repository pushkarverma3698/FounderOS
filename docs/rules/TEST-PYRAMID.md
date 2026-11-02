# Test Pyramid (FounderOS)

Three tiers are live, each owning a named risk. The Seam tier (ordered trace events from
`src/infra/trace.ts`, `tests/unit/gateway/seam-trace.test.ts`, `pnpm test:seam`) was removed
2026-10-10 with the agent kernel.

| Tier | Owns | Where | Command | Gate |
|---|---|---|---|---|
| Unit | pure logic (guards, slicing, parsing, routing keywords) | `tests/unit/**` | `pnpm test` | must-pass |
| Contract | each tool's exact action + fields + soft-fail + no-audit-on-fail | `tests/unit/tools/**` | `pnpm test` | must-pass |
| Real-path | live MTProto over the real gateway | `scripts/telegram-probe.ts`, `scripts/telegram-tap.ts` | `node --import tsx/esm --env-file=.env scripts/telegram-probe.ts "<prompt>"` | advisory/manual |

**Merge gate:** `pnpm gate` (lint, build, runtime-asset, wiring, architecture and doc-claims
checks, then `pnpm test`) runs Unit + Contract (deterministic, no network). The eval and any
LLM/network test (`pnpm test:integration`) is ADVISORY: it never blocks merge. Run real-path
QA before shipping behaviour changes (CLAUDE.md rule #19).

**Why the Seam tier existed:** every production P0 (wedge-loop, reject-loop, stale-reply,
duplicate-instance) passed Unit+Contract but crossed a gateway seam no test asserted. The
jobs pipeline has no run-loop to trace, so the real-path probe is the check that covers the
founder-visible seam now.

## Real-path QA
- `scripts/telegram-probe.ts "<prompt>" [waitSeconds]`: one prompt, every reply, per-reply latency.
- `scripts/telegram-tap.ts`: tap an inline button on a bot message.
- Removed 2026-10-10: `scripts/qa.ts`, `e2e-telegram-qa.ts`, `telegram-tester.ts`, `probe-real-task.ts`.

Both need `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` in `.env` (see `scripts/lib/mtproto.ts`, which also says how to mint a new session).

## Observability (LangSmith) — founder-provided key

> Update 2026-10-27: the turn-level trace (`turn.in`, `route.decided`, `turn.out`) and `telemetry.ts` were removed 2026-10-10 with the kernel. Only the config keys remain; the jobs pipeline writes plain `logger` lines. The section below is the 2026-06 record.

Step-level tracing to LangSmith is **opt-in and requires a founder-supplied API key**.
The code never provisions or commits it. To enable, set in your local `.env` (NOT in
`.env.example`, which only carries placeholders):

```bash
LANGCHAIN_TRACING_V2=true
LANGCHAIN_API_KEY=<your LangSmith key — required from your side>
LANGCHAIN_PROJECT=founderos
```

If `LANGCHAIN_API_KEY` is absent, tracing is a graceful no-op (`telemetry.ts`). The
turn-level **log** trace (`grep <turnId> /tmp/founderos.log`) works regardless of the
key — only the LangSmith dashboard view needs it.

**Live-verified 2026-06-12** (real gateway via MTProto, branch `obs/turn-tracing`):
clean turn (`17×23 → 391`) traced `turn.in → route.decided → llm.call → turn.out`
under one `turnId`; HITL email request paused with `…→ hitl.interrupt` and **no**
`turn.out` (email not sent); reject traced `hitl.resume → turn.out` with **0**
`action_log` rows; boot logged "LangSmith tracing enabled"; 0× 409, single instance.
Confirm spans landed in your LangSmith dashboard (project `founderos`) — that view is
the one piece that needs your key.
