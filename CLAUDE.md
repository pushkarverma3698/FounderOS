# FounderOS — Claude Instructions (v3)

## What This Is
FounderOS is a **deterministic agent kernel** with a Telegram gateway — an
own-brand orchestration product (vs OpenClaw/Hermes-class chat loops) that
runs Turicks operations and generates its own client-facing proof.

**v3 Stack:** Node 22 + TypeScript strict + LangGraph StateGraph (no prebuilt
supervisor) + grammy + drizzle/Postgres + injected models (paid Gemini Flash,
temp 0).

## Architecture (v3 — contract-first, one orchestration path)

```
message → plan (LLM #1: PlannerDecision — direct reply OR typed Plan)
        → dispatch (PURE CODE supervisor: plan[cursor] → TaskEnvelope)
        → agent ⇄ tools (worker: isolated envelope-only context, capped tools,
                         code-recorded ToolReceipts, HITL interrupt() inside gated tools)
        → collect (pure: StepResult validated against OUTPUT_CONTRACTS)
        → … cursor++ … → synthesize (LLM: results only) → reply + receipts block
```

- **Contracts are the architecture**: `src/kernel/contracts.ts` (TaskEnvelope,
  Plan, StepResult, FailureReport, ToolReceipt). Every boundary is Zod-validated;
  a mismatch is a terminal, typed failure — never a retry-and-hope.
- **Zero-hallucination is a mechanism**: action claims require successful
  receipts (`validateStepResult`); the synthesizer sees only validated results.
- **Failures name the real component**: FailureReport = stage + component +
  evidence + retryable. The founder always sees them; threads are NEVER wiped
  (only `/reset` wipes, by explicit founder command).
- **The kernel is a library**: models/tools/checkpointer injected
  (`src/gateway/kernel-boot.ts` is the ONLY composition root). The full graph
  runs offline in CI at $0 (`tests/unit/kernel/kernel-e2e.test.ts`).

## Anti-slop invariants (CI-enforced — scripts/verify-architecture.ts)
1. **Tombstones**: killed modules (office-run, execution-guard, pre-router,
   fast-paths, office.ts, domain subgraphs…) FAIL CI if re-created.
2. **Ratchet**: architecture debt (`governance/architecture-baseline.json`)
   may only shrink. Current: regex-routing 0, gateway-imports 0, kernel-purity 0.
3. **Import direction**: contracts ← kernel ← gateway; kernel may import only
   kernel/core/db/infra/tools.
4. **LOC budget**: no src file over 400 lines.
5. **Fail-open catches** need an `// allow-failopen: <reason>` tag.

## Non-negotiable rules (carried from v2, all still enforced)
- **HITL**: DB row BEFORE interrupt() (`src/infra/hitl.ts`); side effects only
  after approval; idempotency key check before every external send; audit row
  only on real success (`src/kernel/tool-adapter.ts` pins the ordering).
- **Determinism**: temp 0; routing/parsing/guards are pure unit-tested
  functions, never prompt instructions; CI runs the golden set twice —
  plans must be identical.
- **Evidence over assertion (rule #24)**: "done" = the verification command run
  fresh in the same session with output shown. Unit tests are necessary, not
  sufficient — exercise the real path (gateway → kernel → tool → reply →
  action_log row) before claiming anything works. Unverifiable ⇒ say
  "NOT VERIFIED — reason".
- **Fix the schema, not the code**: if a task fails on ambiguous requirements,
  the planner asks for the missing field; never guess data.
- **Bug fixes start with a failing test** (PR template section is mandatory).
- **Memory is the source of truth**: docs/ADR changes → `pnpm brain:sync`;
  significant decisions → episodic memory.
- **Zero paid calls in the dev loop**: unit tests use scripted models;
  `pnpm eval` (live model) is a milestone gate, run once per feature.

## File map
```
src/kernel/            — contracts, signals, state, planner, supervisor (pure),
                         worker, synthesizer, graph, tool-adapter, index
src/gateway/kernel-boot.ts — composition root (models+tools+checkpointer → kernel)
src/gateway/kernel-run.ts  — run loop: lock → gates → invoke → HITL card/reply
src/gateway/telegram.ts    — grammy transport; commands.ts — 7 essential commands
src/agents/            — worker prompts (prompts/, system-prompts.ts),
                         agent-tools/ (LangChain tool wrappers), capabilities.ts,
                         model.ts (status-class error taxonomy)
src/tools/             — UnifiedTool implementations (ToolResult envelope)
src/infra/             — hitl, checkpointer (PostgresSaver), budget, daily-budget,
                         trace, scheduler (maintenance only), health
src/db/                — schema (18 tables) + queries; src/eval/ — golden tasks,
                         runner, scoring, kernel-invoker; src/proof/ — proof renderers
src/mcp/               — MCP server (read-only external surface)
video-factory/         — client social-video engine (standalone npm dir, NOT in
                         the pnpm workspace): brands/ registry, projects/,
                         scripts/produce.mjs (receipt-checkpointed executor);
                         kernel side = src/tools/video-{brand,brief,shotlist,
                         models,compose,production,title-card}.ts (pure, $0) —
                         see docs/VIDEO-FACTORY.md + docs/VIDEO-PIPELINE-AUDIT.md
```

## Commands
```bash
pnpm dev / build / start        # run
pnpm test                       # deterministic suite ($0, scripted models)
pnpm lint && pnpm verify:arch   # types + anti-slop gates
pnpm gate                       # full merge gate (lint+build+wiring+arch+test)
pnpm eval                       # live golden-set eval (milestone gate, paid)
pnpm qa:telegram                # 22-task MTProto founder-simulation (production acceptance)
pnpm proof:scoreboard           # regenerate docs/PROOF.md from a fresh run
pnpm proof:costs                # docs/COSTS.md from ai_call_costs
pnpm proof:case-study <thread>  # anonymized case study from a checkpoint
```

## Model policy
Production (pinned by `scripts/apply-prod-env-overrides.sh`, 2026-07-13):
`AGENT_MODEL=google-genai:gemini-flash-latest` (direct Gemini — proven to tool-call
cleanly on-box; requires the `GOOGLE_GENERATIVE_AI_API_KEY` GitHub secret, else
prod 401s). Fallback chain: same-key paid Gemini first
(`google-genai:gemini-3-flash-preview`, `google-genai:gemini-3.1-flash-lite` —
live-verified serving + tool-calling during the 2026-07-13 gemini-3.5-flash 503
storm), then FREE OpenRouter last resort (founder directive: no paid OpenRouter
fallback): `openrouter:meta-llama/llama-3.3-70b-instruct:free`,
`openrouter:qwen/qwen3-next-80b-a3b-instruct:free`. Temperature 0, planner+workers
(`WORKER_AGENT_MODEL` splits them). Budget caps enforced (`BUDGET_DAILY_USD`,
`RUN_BUDGET_USD`). Provider errors classify by HTTP status class
(`httpStatusOf`/`is503Error`/`isModelFallbackError` in `src/agents/model.ts`):
5xx/429/transport → retriable; 404 → model fallback; 401/403 → fail loud.

## Git
- Never commit to `main`. Flow: work branch → `beta` → `main`
  (CI-enforced by `.github/workflows/branch-policy.yml`). Only humans merge to
  `main`. The former `stable` tier was retired — see ADR-045; production is a
  two-stage promotion, not three.
- Evidence in every PR: fresh `pnpm gate` output + live-path proof (or an
  explicit NOT VERIFIED with the reason).

## History
The v2 system (LLM supervisor + regex pre-router + regex execution guards) was
audited and replaced 2026-07-08 — see `ZERO-BASE-AUDIT.md` (4 live failure
traces), `JARVIS-ARCHITECTURE.md` (the contract-first design), and
`docs/PROOF.md` (the living scoreboard).
