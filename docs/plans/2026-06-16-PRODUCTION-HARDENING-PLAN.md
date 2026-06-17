# Plan: Migrate FounderOS to LangChain v1 — Eliminate the Custom Model Layer, Make It Provider-Agnostic & Crash-Proof

## Context

**The complaint:** every dependency bump or model swap (Gemini→OpenAI) crashes the whole
system; recurring "hallucinations" and instability on a *simple* multi-agent system.

**Verified root cause (accountability):** the instability is **not** the graph layer.
`office.ts` (supervisor + 7 ReAct departments, compiled once, `outputMode:"last_message"`,
`includeAgentName:"inline"`) is textbook LangGraph — *confirmed against LangChain's own
guidance.* The instability lives entirely in **one file, `src/agents/model.ts`**, which
re-implements the framework by hand:

1. A 480-LOC `FounderChatModel extends BaseChatModel` hand-rolls `bindTools`, retry, and
   fallback. **This violates the explicit official rule** ("never hand a
   `bindTools`/`withFallbacks`-wrapped model to the agent — pass a plain model + tools").
   Our exact `llm must define bindTools` crash is documented in LangGraph issues
   [#1217](https://github.com/langchain-ai/langgraphjs/issues/1217) and
   [#1365](https://github.com/langchain-ai/langgraphjs/issues/1365).
2. It depends on **undocumented framework internals** (`.kwargs.tools`, `_shouldBindTools`).
   `package.json` pinned `^0.3.50` but the lockfile drifted to `0.3.80` — a `pnpm install`
   silently moves the internals the wrapper imitates → the seam snaps. **This is the "any
   change breaks it" mechanism, and why Gemini→OpenAI crashed.**
3. It **fabricates model output** (`syntheticResponseFromLastTool`, the fake
   "Original request/tool result" recovery) — when Gemini returns nothing the system
   invents an answer instead of failing loud. A genuine hallucination source, and a
   violation of our own rule #19.5.

**Architecture verdict (research-backed):** ~90% of the design is industry-standard and
correct. Supervisor + specialized sub-agents is LangChain's *benchmarked* recommendation
(single-agent perf drops ~50% as tools grow). `outputMode:"last_message"` is *literally
their #1 best practice* (solves the "telephone problem"; drove their ~50% benchmark gain) —
we already do it and guard it. The one deviation is the custom model layer. Separately, we
are **one major version behind**: `createReactAgent` is **deprecated** in LangGraph v1
(GA Oct 2025), replaced by `createAgent` (`langchain` pkg) + a **middleware** system that
ships an **official `modelFallbackMiddleware`** and `initChatModel()` provider-agnostic init
— i.e. v1 provides as a first-class feature the exact thing our wrapper hacks together.

**Decisions (confirmed with founder):**
- **Migrate to LangChain v1** (`createAgent` + official middleware), **keep `createSupervisor`**
  (still supported, v1.0.4). Adopt `initChatModel` + `modelFallbackMiddleware`. Delete
  `model.ts` entirely. Provider-agnosticism (swap `AGENT_MODEL` env, zero code change) is a
  **hard, live-verified deliverable**. Default model decided *after* via A/B.
- **Spike v1 on ONE department (`research`) first**, prove route+tool+HITL live through the
  real gateway, *then* roll out to the rest. Evidence-first (rule #19).

**Outcome:** the perfect, supported, provider-agnostic model layer; no fabrication; official
cross-provider fallback that survives credit depletion; on the stable, current framework
(no-breaking-changes-until-2.0). A clean portfolio/demo story instead of a liability.

---

## Target versions (pin EXACT — no carets; drift is what broke us)
`@langchain/langgraph` `1.4.1` · `@langchain/langgraph-supervisor` `1.0.4` · `langchain` v1
(latest 1.x) · `@langchain/core` v1-compatible (latest 0.3.x/1.x per peer deps) ·
`@langchain/google-genai`, `@langchain/openai`, `@langchain/anthropic` to their v1-peer
versions. Lock all `@langchain/*` to exact and document a tested upgrade cadence in the ADR.

---

## Phase 0 — Research spike branch `spike/v1-research-dept` (de-risk before committing)

Goal: prove the v1 stack works on our hardest paths *before* touching the whole office.

1. Install v1 packages (exact-pinned) in the branch. Resolve peer-dep conflicts.
2. **Build a throwaway single-department graph**: `createSupervisor({ agents: [research], ... })`
   where `research = createAgent({ model, tools, systemPrompt, middleware: [...] })`.
3. **Resolve the THREE known-unknowns and write findings into the ADR:**
   - **(a) HITL interrupt/resume.** Our tools call `interrupt()` from `@langchain/langgraph`
     and the gateway reads `getState().tasks[].interrupts` (`office.ts:193 getPendingApproval`,
     resume in `gateway/telegram.ts`). Confirm v1 createAgent preserves this exact
     interrupt/resume + checkpointer contract. Drive a real HITL tool (e.g. `send_email`)
     through `scripts/probe-real-task.ts` AND `scripts/e2e-telegram-qa.ts` (MTProto). Evidence
     = approval card + resume + `action_log` row.
   - **(b) Rolling-window trimmer.** v0.2 passes `createTrimmedPrompt` as the `prompt`
     MessageModifier (`src/infra/context-manager.ts`). v1 uses `systemPrompt` (string) +
     middleware. Re-implement trimming as middleware (`wrapModelCall` / before-model hook
     that trims `request.messages` to the token budget) and the date-fresh prompt as
     `dynamicSystemPromptMiddleware`. Verify history is bounded and the system prefix stays
     byte-stable (implicit-caching lever, rule #20).
   - **(c) Supervisor's own routing-model fallback.** `modelFallbackMiddleware` attaches to a
     `createAgent` (departments are covered). Confirm whether `createSupervisor` 1.0.4 accepts
     `middleware` (or `pre/postModelHook`) so the SUPERVISOR's routing model also gets
     fallback. If NOT supported: give the supervisor a resilient model via `initChatModel`
     with native retry, and document the residual gap (or, contingency, evaluate a manual
     handoff-tool supervisor for the supervisor node only). Decide + record in ADR.
4. **Exit criterion for Phase 0:** research department + a 1-agent supervisor route + tool-call
   + HITL approve/reject, verified live, with `modelFallbackMiddleware` proven to fail over
   Gemini→(OpenAI/Anthropic) on a forced primary failure. If any of (a)/(b)/(c) can't be made
   clean, STOP and re-present before the full migration.

---

## Phase 1 — Provider-agnostic model module (`src/agents/model/`)

Replace `src/agents/model.ts` (delete the whole `FounderChatModel`):

- **`index.ts`** — `getModel()` keeps its signature (consumers untouched). Returns a plain
  model via `initChatModel(process.env.AGENT_MODEL)` — provider inferred from the prefixed id
  (`google-genai:gemini-2.5-flash`, `openai:gpt-4o-mini`, `anthropic:claude-haiku-4-5`).
  Temperature 0 default (rule #16), `AGENT_TEMPERATURE` override.
- **`fallback.ts`** — `getModelFallbackMiddleware()` builds `modelFallbackMiddleware` from a
  new env `AGENT_FALLBACK_MODELS` (comma list of prefixed ids, **cross-provider/key** so
  credit-depletion fails over). Exported for every `createAgent`.
- **Keep only** the deterministic predicates worth keeping (`is503Error`,
  `isQuotaExhaustedError`) IF needed to tune retry; otherwise rely on middleware defaults.
- **Delete entirely:** `syntheticResponseFromLastTool`, `isNoCandidatesError` synthetic path,
  `GeminiAdapter`/`StandardAdapter`, the manual retry loop, OpenRouter special-casing. The
  Gemini `stripNames`/empty-message quirk: re-test on v1 google-genai — if still needed, a
  tiny middleware, NOT a 480-LOC class. On empty output → fail loud or fall through, never
  fabricate.

---

## Phase 2 — Roll out v1 to the office (after Phase 0 green)

Pattern, applied per department (representative files):
- **Departments** (`office.ts`, `engineering-domain.ts`, `revenue-domain.ts`): `createReactAgent`
  → `createAgent` (import from `langchain`). `prompt:` MessageModifier → `systemPrompt` +
  trimming/dynamic-prompt **middleware**; add `modelFallbackMiddleware`. Plain model + separate
  `tools` (the official rule).
- **Supervisor** (`office.ts:141 createSupervisor`): keep `createSupervisor` from
  `@langchain/langgraph-supervisor@1.0.4`. Keep `outputMode:"last_message"` (+
  `assertContextIsolation` guard) and `includeAgentName:"inline"`. Apply the Phase-0 decision
  for supervisor-model fallback.
- **No graph topology change** — same 7 departments, same handoffs, same checkpointer
  (`getCheckpointer`), same `getPendingApproval`/resume contract (verified in Phase 0).
- `src/infra/context-manager.ts`: convert `createTrimmedPrompt` to the v1 middleware form
  proven in Phase 0 (keep `estimateTokens`/`trimMessages` reuse).

---

## Critical files

| File | Change |
|---|---|
| `package.json` | v1 packages, **exact** pins; add `langchain` |
| `src/agents/model.ts` → `src/agents/model/{index,fallback}.ts` | Delete wrapper; `initChatModel` + `modelFallbackMiddleware` |
| `src/agents/office.ts` | `createReactAgent`→`createAgent`; attach fallback middleware; keep `createSupervisor` |
| `src/agents/engineering-domain.ts`, `src/agents/revenue-domain.ts` | Same agent-API migration |
| `src/infra/context-manager.ts` | Trimmer → v1 middleware |
| `src/core/config.ts` | Add `AGENT_FALLBACK_MODELS`; `AGENT_MODEL` default → prefixed id |
| `.env.example` | Document `AGENT_MODEL` (prefixed), `AGENT_FALLBACK_MODELS`, per-provider keys |
| `tests/unit/agents/model*.test.ts` (4) | Rewrite to the new contract |
| `docs/decisions/028-langchain-v1-model-agnostic.md` | **New** ADR: root cause + v1 decision + Phase-0 findings |
| `docs/LIMITATIONS.md` | Update #2 (model.ts) — resolved |

Tool definitions, `capabilities.ts`, HITL `interrupt()` calls, gateway, DB: **unchanged**
(pending Phase-0 confirmation of the interrupt/resume contract).

---

## Tests (TDD, rule #11 — write/rewrite first)
- **Provider-agnostic init**: `getModel()` returns a working model for each prefixed id
  (google-genai/openai/anthropic) without code change.
- **Fallback fires**: primary throws → `modelFallbackMiddleware` switches provider and
  produces output; quota-exhausted → no wasted retries.
- **No fabrication**: empty primary + empty fallback → honest throw; assert NO synthetic
  output anywhere (replaces the old synthetic tests).
- **Trimmer middleware**: history bounded to budget; system prefix preserved.
- Keep the full suite green (1000+ tests). Update any test asserting v0.2 internals.

---

## Verification (provider-agnosticism + stability are the deliverables; rule #19)
1. `pnpm lint` clean + `pnpm test` green.
2. **Live cross-provider proof on the REAL gateway**, env-only swap, for each provider:
   `AGENT_MODEL=google-genai:gemini-2.5-flash` · `openai:gpt-4o-mini` · `anthropic:claude-haiku-4-5`.
   Run a route→tool-call→HITL task via `scripts/probe-real-task.ts` AND
   `scripts/e2e-telegram-qa.ts`. Evidence = exact bot reply + matching `action_log` row per
   provider. Any provider not run live → "NOT VERIFIED — reason", not claimed done.
3. **Failover proof (the credit-depletion scenario that bricks the bot today):** primary with
   a bad/empty key + valid `AGENT_FALLBACK_MODELS` → log shows provider failover, founder still
   gets a real answer.
4. **Regression sweep:** full `pnpm e2e-telegram-qa` 22-task suite (read/write/multi-step/
   adversarial/crash-recovery) on the migrated office; confirm nested HITL + context isolation
   intact. `pnpm eval` not regressed vs the golden set.
5. **A/B for default:** with the layer proven agnostic, compare providers on eval + real tasks;
   pick the production default by observed failure rate (not assumption). Record in ADR-028.

## Rollout & decision sync
Live prod → branches `spike/v1-research-dept` then `feat/langchain-v1-migration` off `main`;
human-merged PRs only (rule: never direct to main, only humans merge). Each step verified live
before the next. Post-merge (rules #18/#028): write ADR-028, `pnpm brain:sync`, update
`MEMORY.md` + a topic memory file, regenerate the knowledge graph.

## Risk register
- **HITL/resume semantics differ on v1** → mitigated by Phase-0 spike before any office change.
- **Supervisor-model fallback not supported by createSupervisor middleware** → Phase-0 known-
  unknown (c); contingency documented.
- **Peer-dep / ESM `.js`-extension friction on v1** → resolve in Phase 0 install step.
- **Big-bang risk** → eliminated by spike-first + per-department rollout + live checks between
  increments.
