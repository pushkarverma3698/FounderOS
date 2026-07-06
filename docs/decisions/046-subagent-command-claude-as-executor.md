# ADR-046 — `/subagent` Command: Claude Code as Executor, FounderOS as Governance

**Status:** Accepted · **Date:** 2026-07-06 · **Branch:** `claude/session-pjgqsp`

## Context

The founder wanted an engineering workflow (`/subagent`) that, given a task,
produces an implementation plan, breaks it into subtasks, and runs a loop of
"specialised subagents" until the task is achieved end-to-end — with the
reliability and intelligence of Claude Code.

The critical realisation: **Claude Code already does plan → decompose → spawn
subagents → loop → verify, internally.** The `claude_code` tool
(`src/tools/claude-code.ts`) already wraps the Claude Code CLI headless with a
strong model, file tools, and a verification loop. So the real question was not
"how do we build an orchestration loop" but "how much orchestration does
FounderOS own vs. delegate to the Claude Code session?"

## Decision

**Claude Code is the EXECUTOR; FounderOS is the GOVERNANCE layer around it.**
We do not build a FounderOS/Gemini planner-executor loop that re-implements what
Claude Code does (that fragments Claude's context across sessions → worse
completion, and burns the paid Gemini budget to coordinate — see the token
analysis below). Instead:

`/subagent <task>` runs a **plan → approve → execute** flow:

1. **Plan pass** — `claude_code` in new `mode:"plan"` (`--permission-mode plan`,
   read-only tool allowlist `Read Glob Grep WebFetch WebSearch`, 5-min timeout).
   Writes nothing, so it needs **no HITL**. Returns a decomposed implementation
   plan, surfaced to the founder in Telegram.
2. **Execute pass** — the task + approved plan are dispatched through the office
   (`runOfficeText`) → engineering → `claude_code` (execute mode), which fires
   the **one existing HITL approval card**, then Claude runs the whole task
   end-to-end (spawning its own subagents internally).

Only the plan flag is new; execution reuses the proven office + HITL + audit +
idempotency path (rule #17 reuse-first; architecture stays locked — "add tools
only").

### Own-agents-as-fallback (deferred)

Routing subtasks to FounderOS's own `coder/qa/devops` agents (the gated
`engineering-domain.ts` CTO subgraph) when the Claude limit is exceeded is a
sound cost-aware-degradation pattern and a good portfolio signal — but it is a
**later** addition, not v1. Primary path = Claude; fallback tier comes once the
primary is proven.

## Token burn (tentative, why Claude-as-executor wins)

Two budgets: **paid Gemini** (rule #23 protects this) and **Claude**
(subscription/executor login — rate-limited, not per-token billed).

| Approach | Gemini ($) | Claude | E2E completion |
|---|---|---|---|
| **A — Claude does all** (chosen) | ~1–3k (routing only) | High but efficient: one shared session | **Best** — context never fragments |
| **B — FounderOS drives loop** | **~80k–200k** (planner + per-phase routing + verify + retries) | Higher *total* — N sessions each re-load context | Worse — Claude loses the thread between subtasks |
| Hybrid (plan gate + loop) | ~30k–80k | plan session + execution sessions | Good |

Approach B is both the most expensive on the founder's real budget AND the worst
completion. Approach A concentrates cost on the Claude side and completes best.
This directly motivated the decision.

## Self-critique (rule #12)

1. **Double-orchestration risk** — two planners fighting (FounderOS loop +
   Claude's internal Task tool). *Resolved:* FounderOS owns only the coarse
   plan-approve gate; Claude owns fine-grained subagent spawning inside one
   execute session. No FounderOS leaf loop.
2. **Wedged-interrupt scar tissue (rule #19)** — a HITL card per subtask would
   recreate the interrupt-loop fragility. *Resolved:* exactly one HITL gate (the
   existing `claude_code` approval); plan pass is read-only and needs none.
3. **Cost/latency (rule #23)** — each spawn is a full CLI session. *Resolved:*
   plan pass is read-only + short-timeout (5 min); execution is the single proven
   `claude_code` path; loop logic (`buildClaudeCliArgs`, `buildSubagentBrief`)
   is pure + unit-tested rather than a live probe.

## Files touched (wiring)

- `src/tools/claude-code.ts` — `mode:"plan"|"execute"`; pure `buildClaudeCliArgs`;
  `PLAN_DIRECTIVE` / `withPlanDirective`; `PLAN_TIMEOUT_MS`; read-only plan
  allowlist.
- `src/gateway/commands.ts` — `handleSubagent` + pure `buildSubagentBrief`;
  `/subagent` help line; `claudeCodeTool` import.
- `src/gateway/telegram.ts` — import + `bot.command("subagent", …)`.
- `tests/unit/tools/claude-code.test.ts` — plan/execute arg-builder + directive
  idempotency tests.
- `tests/unit/gateway/commands.test.ts` — `buildSubagentBrief` + `handleSubagent`
  plan-success / plan-failure-fallback / empty-task tests.

## Verification

- `pnpm lint` → exit 0.
- `pnpm test` → 171 files / 1729 tests green.
- **NOT VERIFIED LIVE** — the real Telegram → plan card → approve → execute path
  has not been run through MTProto in this session (rule #19.4 / #24). Live QA is
  the next gate before this is claimed production-working.

## Consequences

- Founder sees the implementation plan and approves the build with one card.
- FounderOS keeps its differentiated value (routing, HITL, audit, cost tracking,
  confinement) without trying to out-code Claude — which is also the strongest
  2026 AI-engineering hiring narrative: *the harness around a frontier coder*.
