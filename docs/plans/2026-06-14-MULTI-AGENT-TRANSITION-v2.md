# FounderOS — Production-Grade Multi-Agent Transition (v2 plan, re-critiqued)

## STATUS (2026-06-14) — Phases 1–4 SHIPPED

- ✅ **Phase 1** — context isolation pin + per-turn token measurement. PR #63, ADR-021.
- ✅ **Phase 2** — typed inter-dept contracts (`src/agents/contracts.ts`). PR #64, ADR-022.
      (Live `stateSchema` channel deferred to Phase 5 = its first real reader.)
- ✅ **Phase 3** — Claude-as-judge (gen≠critic, rule #6), outbound gate 2. PR #66, ADR-023.
      ⚠️ active only with `ANTHROPIC_API_KEY` (absent in dev → no-op pass).
- ✅ **Phase 4** — durable `dept_signals` over Postgres + revenue sweep. PR #67, ADR-024.
      Live-verified real Postgres round-trip (publish→consume-once→nudge).
- ✅ **Phase 5** — hierarchy proof (nested HITL on prebuilts). PR #68, ADR-025.
      Live-verified GREEN vs Gemini (3-level interrupt/reject/approve). Production stays FLAT;
      promotion double-gated (coordination trigger + live MTProto).
- ✅ **Phase 6 (docs)** — CLAUDE rules #20–21. PR #69. (brain:sync + graph regen = post-merge.)
- ⏳ **Phase 7** — specialist hardening pass. **Run AFTER #63–#69 merge** (specialists need a
      unified base on `main`, not 6 stacked branches). Founder-triggered.

### Post-merge checklist (founder action)
1. Merge order: #63 (P1) → #64 (P2) → #66 (P3) → #67 (P4, stacked on #64) → #68 (P5) → #69 (P6).
   (#65 is unrelated background gateway/claude-code work — review separately.)
2. `pnpm brain:sync` (upserts ADR-021…025) · regen `.claude/graph.json` (research now has publish_signal).
3. Set `ANTHROPIC_API_KEY` in prod to activate the judge (gate 2). Optional `JUDGE_MODEL`.
4. Live MTProto nested-HITL verify IF/WHEN promoting nesting to production (else keep flat).
5. Then Phase 7 (spawn prompt-engineer + llm-architect + code/security reviewers).

---

## Context

An external advisor's "prototype → production SaaS" doc (containers, broker, hierarchy, judges,
tracing) is generic and unaware of the code. A file-grounded audit shows FounderOS already ships
~70–75% of it: Postgres checkpoints, DB-backed nested HITL, budget guards, LangSmith, per-turn
`trace_id` seam logging, deterministic pre-router, namespaced `founder_context`, idempotency,
path-guard. The pinned `@langchain/langgraph-supervisor@0.0.20` already supports `stateSchema`,
nested-supervisor-as-agent, `outputMode`, `preModelHook`, `postModelHook`, `responseFormat` — so the
genuinely-absent items can be built ON the prebuilt library (no `StateGraph` rewrite; ~500-LOC core
and the fragile HITL run-loop preserved).

This v2 plan re-critiques the first draft and optimizes for **less work + better architecture**:
1. **Decouple substrate from topology** — ship reliability/isolation/contracts/judge/signals on the
   FLAT system first (zero run-loop risk); make actual nesting a single contained, late,
   trigger-gated *proof*, not an upfront blocker.
2. **Token win is prompt structure, not infra** — Gemini 2.5 Flash does implicit prompt caching by
   default (≤75% off cached prefixes). Make prompts prefix-stable; lean on it. No Redis, no explicit
   caching.
3. **Cheapest reliable contracts** — typed scoped state channels (no extra LLM call); `responseFormat`
   only where a typed final output earns its extra call.

## Redis / prompt-caching decision (researched)

- **Gemini 2.5 Flash implicit caching is ON by default**, automatic, ≤75% discount on cached tokens,
  triggers on shared **prefix** (≥1024 tok), reported in `cached_content_token_count`. Best practice:
  stable content first, volatile last. → Free token lever; action is prompt structuring.
- **Explicit Gemini context caching is incompatible with tool-calling agents** (`cached_content` 400s
  with tools/system_instruction/structured-output). FounderOS is all tool-calling → do NOT pursue.
- **Redis: NO (for caching).** Adds nothing over free implicit caching; app-level response cache has
  near-zero hit rate in interactive temp-0 use. Redis's real value (atomic cross-instance
  quota/rate-limit) is a Phase-E multi-instance concern. Keep the dormant `redis.ts` stub; re-add at
  Phase E. (Matches the codebase's own deferral note.)

## Gap map (verdict)

| Proposed | Today | Action |
|---|---|---|
| Postgres ckpt / nested HITL / budget / LangSmith / trace_id / idempotency / path-guard / namespaced state / pre-router | PRESENT | keep |
| Context isolation + token | PARTIAL (flat `messages`, `createTrimmedPrompt`-as-prompt) | **Phase 1** |
| Typed task contracts | ABSENT (prompt-driven) | **Phase 2** (channels) |
| Judge / generator≠critic (rule #6) | ABSENT in code | **Phase 3** (`postModelHook`) |
| `dept_signals` event bus | SCAFFOLDED (0 callers) | **Phase 4** (Postgres) |
| Hierarchical supervisors | ABSENT (flat 7) | **Phase 5** (1 proof, trigger-gated) |
| gVisor containers · BullMQ broker · Redis | ABSENT | **defer + ADR** (Phase-E gates) |

## Phasing (each = own PR + ADR; `pnpm test` + `pnpm lint` + `pnpm eval` green; live-verified, rule #19)

- **Phase 1 — Context isolation + token (explicit ask; flat; lowest risk; ship-independent).**
  Explicit `outputMode:"last_message"` (verify internal steps don't escape). Migrate
  `createTrimmedPrompt`-as-prompt → `preModelHook`, **prefix-stable**: system+manifest prefix
  byte-identical across turns; trim only the history *suffix*; move per-turn dynamic data
  (date, `founder_context`) OUT of the cacheable prefix into the suffix. Unit-test prefix stability.
  Measure tokens/turn + `cached_content_token_count` before/after on the golden set.
- **Phase 2 — Typed inter-dept contracts + scoped channels (flat).** NEW `src/agents/state.ts`:
  `OfficeState = Annotation.Root` extending `MessagesAnnotation` with *minimal* scoped channels.
  Zod contract types; a deterministic step validates + writes the typed object to a channel
  (no extra LLM call); the next dept reads it. `responseFormat` only where a typed final output is
  worth the extra post-loop LLM call.
- **Phase 3 — Claude-as-judge (`postModelHook`, outbound-only, generator=Gemini / critic=Claude).**
  Deterministic `brand-validator` = gate 1; Claude judge = gate 2 only when gate 1 passes AND stakes
  are high (email/linkedin/code); bounded retries reuse `brand-retry` TTL; fail → HITL w/ critique.
  Makes rule #6 real.
- **Phase 4 — `dept_signals` durable async over Postgres (NOT BullMQ/Redis).** `publish_signal` tool +
  consumer in `src/infra/scheduler.ts`, reusing existing `publishDeptEvent`/`consumePendingEvents`.
  One exemplar `lead_discovered → revenue outreach` (HITL-gated).
- **Phase 5 — Hierarchy proof (highest run-loop risk → late + isolated + trigger-aware).**
  De-risk spike: `tests/integration/nested-hitl.test.ts` RED-first. ONE exemplar nested domain
  (`revenue` supervisor over {marketing, sales}) consuming the Phase-2 substrate. **Gate: nested
  interrupt/resume/wedge live-verified (MTProto) or STOP & reassess.** Depth capped at 2; pre-router
  bypass preserved. Shattering into more micro-agents is trigger-gated (≥2 coordinating agents in a
  domain) — not done preemptively.
- **Phase 6 — Docs / rules / portfolio.** CLAUDE rules #20–#21 (below); fix stale refs (`state.ts`
  absent; run-loop = `office-run.ts` not `telegram.ts`); ADRs 021 hierarchy-on-prebuilt,
  022 judge/gen≠critic, 023 dept_signals-over-Postgres, 024 no-Redis/no-explicit-caching
  (implicit + prefix-stable; Redis→Phase E), 025 deliberate non-adoption of gVisor/containers;
  regenerate `.claude/graph.json`; `brain:sync`; brand-guidelines case study.
- **Phase 7 — Final production-hardening pass (founder ask; spawn specialists).**
  - `prompt-engineer`: compress + prefix-stabilize the full prompt surface (supervisor, revenue,
    judge, dept prompts) to maximize implicit-cache hits; eval-gated before/after; routing held.
  - `llm-architect` (context/token engineer): least-context audit (input projection per boundary),
    token/cost dashboard (tokens/turn · `cached_content_token_count` · $/turn), model-routing review.
  - `code-reviewer` + `security-reviewer`: final sweep.
  - Output: measured token/cost-reduction report + production sign-off.

## CLAUDE rules update (founder ask: "context leakage shouldn't be from anywhere")

Rules #20–#21:
1. Only **synthesized results** cross a graph boundary (`outputMode:"last_message"`); internal steps
   never propagate up.
2. Inter-dept handoffs use **typed channels/contracts**, never raw message dumping.
3. `preModelHook` is the **single** trimming mechanism; it MUST preserve the cacheable system prefix
   (trim suffix only) — per-turn dynamic data lives in the suffix.
4. **Least-context-by-default**: each boundary declares what it reads (input projection) and emits.
   This + prefix-stable prompts is the concrete, *measured* token lever (the "beat openclaw/hermes"
   claim = evidence, not slogan).
5. Judge runs on a **different model family** (rule #6, now enforced in code).

## Critical files

`src/agents/office.ts` (hooks/outputMode/nesting) · `src/agents/state.ts` **NEW** (OfficeState +
Zod contracts) · `src/infra/context-manager.ts` (`createTrimmedPrompt`→`preModelHook`, prefix-stable)
· `src/infra/judge.ts` **NEW** (reuse `brand-validator.ts`+`brand-retry.ts`) ·
`src/agents/agent-tools/signals.ts` **NEW** + `src/infra/scheduler.ts` consumer ·
`src/db/queries.ts` (reuse existing signal queries; no new SQL) ·
`src/gateway/office-run.ts` (621 LOC, fragile — touch ONLY as `nested-hitl.test.ts` demands) ·
`src/eval/golden-tasks.ts` (2-level routing + judge-coverage cases) ·
`CLAUDE.md`, `docs/decisions/021..025-*.md`, `.claude/graph.json`.

## Self-critique (rule #12)

1. *Deferring real nesting contradicts "pre-build substrate."* The HARD substrate (channels, typed
   contracts, isolation, judge) IS built (Phases 1–4) and PROVEN hierarchically by Phase 5's single
   exemplar; only at-scale shattering is trigger-gated. Honors intent, cuts risk.
2. *Implicit caching savings are unpredictable (opaque TTL).* True — it's free + automatic; we MEASURE
   `cached_content_token_count` to confirm hits and never depend on it for correctness, only cost.
   Explicit caching is ruled out (tool-incompatible), so implicit is the only viable lever — zero infra.
3. *preModelHook trimming vs. prefix-stability tension.* Resolved: trim suffix only; unit-test the
   prefix is byte-identical across turns. Couples isolation with caching instead of fighting it.

## Verification

`pnpm test`/`lint`/`eval` green per phase. Phases 3/5: live MTProto via `scripts/e2e-telegram-qa.ts`
(exact bot reply + `action_log` row / explicit NO ROW). Phase 1 & 7: token-per-turn +
`cached_content_token_count` delta table. Phase 3: judge rewrites an off-brand draft, passes a clean
one. Phase 4: probe `lead_discovered` → scheduler sweep → revenue card.

## Portfolio framing

Hierarchical-capable LangGraph orchestration · LLM-as-judge (gen≠critic) · typed inter-agent
contracts · **measured** token optimization via implicit caching + least-context · durable
event-driven coordination over Postgres · eval-gated verification-first delivery · ADRs documenting
deliberate non-adoption (gVisor/BullMQ/Redis) = senior judgment. Brand-guidelines applied to the
external case-study copy.
