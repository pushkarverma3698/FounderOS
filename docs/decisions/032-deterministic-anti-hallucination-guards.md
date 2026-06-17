# ADR-032: Deterministic anti-hallucination guards (model-agnostic)

**Date:** 2026-06-17
**Status:** Accepted
**Supersedes/relates:** ADR-021 (context isolation), ADR-023 (judge), rules #16, #19, #22, #24

## Context

Production exhibited the most damaging failure class: the agent answered
business/memory questions **from its own parametric weights instead of calling a
DB/memory tool**, then hallucinated facts about Turicks/Naggar — "not doing
anything, just chatting." Root cause was twofold:

1. **Wrong production model.** The deploy pipeline pinned
   `openrouter:openai/gpt-4o-mini` (a Gemini-credits-depleted stop-gap). gpt-4o-mini
   is too weak for this supervisor + ReAct topology — it skips tool calls. Reverted
   to `openrouter:google/gemini-2.5-flash-preview-05-20` in `deploy.yml` +
   `model.ts:DEFAULT_AGENT_MODEL` (also dropped the deprecated `gemini-2.0-flash`
   fallback, gap G2).
2. **No structural guard.** The tool-layer anti-fabricate sentinels
   (`context.ts`, `knowledge.ts`) only fire if the tool is *called*. Skip the call,
   skip the guard. Nothing forced the model to use memory.

A model swap should never be one config change away from this failure. The fix
must be **deterministic code, not a prompt instruction a weak model may ignore**
(rule #16).

## Decision

Two model-agnostic, deterministic mechanisms (both pure, unit-tested):

### 1. `detectUnbackedMemoryClaim` execution-guard
`src/gateway/execution-guard.ts`. When the founder asks an internal-knowledge
question (`INTERNAL_KNOWLEDGE_RE` — Turicks/Naggar/our ICP/strategy/"what did we
decide"/founder context) and **zero** memory tools (`read_context`,
`search_memory`, `search_knowledge`, `search_turicks_brain`) fired this turn, the
gateway forces a retry with a directive to call the tools first. Explicit
web/research prompts (`EXTERNAL_RESEARCH_RE`) are excluded — those legitimately
skip memory. Mirrors the existing shell/inbox/linkedin guards; wired into
`needsExecutionGuardRetry` + `buildGuardRetryMessages` ("memory" kind).

### 2. Structured tool-failure envelope
`src/agents/tool-result.ts`. `toolFailure(stage, message)` returns a
founder-readable `❌ <message>` line plus a stable machine marker
`[[TOOL_FAILURE stage=<stage>]]`. `isToolFailure` now detects the marker
**deterministically first** (then the legacy `{success:false}` flag, then the
first-line keyword fallback). `stage` names the REAL failing component (rule #22):
a DB failure says `db`/Postgres, an embedding failure says `embedding`/Ollama —
never collapsed or misattributed. `withToolErrorBoundary` wraps DB tool bodies
(`read_context`, `update_context`, `search_knowledge`) so a Postgres exception
becomes a stage-tagged envelope, not a raw crash or a swallowed error.

## Consequences

- Determinism holds across model swaps: even a weak model is forced onto the tool
  path for internal-knowledge questions.
- Real tool failures surface to the founder with the correct component named — no
  more "✅ Done." hiding a DB outage, no more misattributed errors.
- Does NOT touch the eval-gated prompts or the locked graph topology.

## Verification

- Repro-test-first (rule #23, $0): `detectUnbackedMemoryClaim` RED→GREEN (12→0
  fails); `tool-result` envelope 7/7; `isToolFailure` marker path proven RED→GREEN
  (passes with marker check, fails without).
- `pnpm lint` exit 0; `pnpm test` **1219/1219** green (merged with knowledge guard v2 from beta).
- Merged `detectUnbackedMemoryClaim` (force tool call) with `detectUnbackedKnowledgeClaim` (block fabrication).
- NOT YET live-confirmed on prod Telegram — requires deploy + trace showing memory tools fired.
