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

### The founder-simulation suite (`scripts/e2e-telegram-qa.ts`) — 29 tasks, 7 groups

This is the hardest real-path test: it drives the LIVE bot over MTProto exactly as
the founder would, and grades each task on TWO evidence streams — the exact bot
reply AND the real `action_log` row (or NO ROW). **Whenever a QA session finds a
new failure class, add a task here so it can never silently regress** (this is how
the suite grew from 22 → 29 on 2026-06-12).

| Group | Owns |
|---|---|
| group1 | read-only routing (research, comms, engineering, personal, context) |
| group2 | write + HITL (email, GitHub, LinkedIn, shell) → approve → audit row |
| group3 | multi-step chains (info must survive between departments, no hallucination) |
| group4 | adversarial (injection, path-guard, ambiguity, idempotency, brand validator) |
| group5 | crash recovery (HITL card survives a restart — `park` then `approve-last`) |
| group6 | capability depth — quantitative reasoning, research synthesis + verdict, table formatting, **HITL-cannot-be-socially-engineered**, **claude_code executor** |
| group7 | **media translation** — photo (image OCR+translate) and voice note, driven via `sendFile` (Bot API cannot) using committed fixtures in `tests/fixtures/qa/` |

Run: `node --env-file=.env --import tsx/esm scripts/e2e-telegram-qa.ts run <all|groupN|TNN> [--approve]`.

**Auto-graded content checks:** a task may declare `mustContain` / `mustNotContain`
substrings (case-insensitive, checked across the full reply). These turn an eyeball
into a signal — e.g. T27 asserts the claude_code reply contains `Fizz`/`Buzz` and
does NOT contain the old jargon `⚙️ Write`. A `🚨`/`⚠` in the SIGNALS block = look.

**Media fixtures** (`tests/fixtures/qa/menu-fr.png`, `voice-fr.ogg`) are committed so
T28/T29 are reproducible. To regenerate: image via Chrome headless
`--screenshot` of an HTML file (PIL here lacks freetype); foreign audio via macOS
`say -v Thomas …` piped through `ffmpeg -c:a libopus`.

## Observability (LangSmith) — founder-provided key

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
