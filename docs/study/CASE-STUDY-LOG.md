# Turicks / FounderOS — Case Study Log

> Append-only record of milestones, decisions, and metrics.
> After 1 year, compile into a public case study.
> All entries go in reverse-chronological order (newest first).

---

## 2026-06-17 — ADR-032: Deterministic Anti-Hallucination Guards

**Milestone**: Model-agnostic execution guard + structured tool failure envelope — merged.

**Trigger**: Production exhibited the most damaging failure: the agent answered internal-knowledge
questions from its own weights instead of calling memory tools. Root cause: (1) wrong production
model (`gpt-4o-mini` — too weak for this topology), (2) no structural guard forcing tool use.

**What was built:**
- `src/gateway/execution-guard.ts`: `detectUnbackedMemoryClaim()` — pure regex guard on the
  gateway. When an internal-knowledge question (Turicks, Naggar, "what did we decide") is asked
  and zero memory tools fired, forces a retry with directive to call tools. Deterministic — works
  across model swaps.
- `src/agents/tool-result.ts`: `toolFailure(stage, message)` — structured failure envelope with
  `[[TOOL_FAILURE stage=X]]` machine marker. Each tool names its REAL failing component (db,
  embedding, composio, etc.) — no more misattributed errors.
- `withToolErrorBoundary()` wraps DB tool bodies so Postgres exceptions become stage-tagged
  envelopes, not raw crashes or swallowed errors.

**Metrics**: `pnpm test` 1219/1219 green. `pnpm lint` exit 0.

**Key lesson (rule #22):** A misattributed error is worse than no error — it sends debugging
down the wrong road. Errors must name the REAL failing component.

---

## 2026-06-14 — Phases 1–6 Hardening Complete (PR #70)

**Milestone**: Production multi-agent hardening — 6 phases merged to main. 1008 tests green.
90% routing eval. 0 data loss.

**Phase 1 — Context isolation + token measurement (ADR-021):**
- Pinned `outputMode: "last_message"` with `assertContextIsolation()` boot-time guard
- Per-turn `inputTokens`/`outputTokens`/`usd` logging on the `turn.out` seam
- Confirmed Gemini implicit caching is the token lever (no Redis needed for caching)

**Phase 2 — Typed inter-department contracts (ADR-022):**
- `src/agents/contracts.ts` — 6 event types, Zod schemas, compiler-enforced parity
- `validateSignalPayload()` — deterministic, total, never throws
- Closed `SIGNAL_EVENT_TYPES` tuple with `satisfies Record<SignalEventType, ...>` guard

**Phase 3 — Claude-as-judge (ADR-023):**
- `src/infra/judge.ts` — Gate 2 in the 3-layer quality gate
- Different model family (Claude) from Gemini drafter — no sycophancy
- Fail-open, memoized, deterministic parse, temp 0
- 14 unit tests covering all edge cases (fail-open, memoization, channel collision)

**Phase 4 — Durable dept signals (ADR-024):**
- `publish_signal` tool + hourly `sweepDeptSignals` cron consumer live
- Exactly-once semantics (atomic consumed flag)
- Live-verified: publish → row → consume → nudge → second consume = 0

**Phase 5 — Hierarchy proof (ADR-025):**
- `src/agents/revenue-domain.ts` + `src/agents/engineering-domain.ts` implemented
- `tests/integration/nested-hitl.test.ts` — 3-level HITL proven GREEN against live model
- Both subgraphs off by default; gated on real coordination trigger

**Phase 6 — Rules #20–21 operationalized:**
- `SECURITY-RULES-20-21.md` guide written
- Structural test: forbids `"full_history"` anywhere under `src/agents/`

**Portfolio value:** Every phase claim backed by evidence (unit tests, live Postgres verify,
integration test). "Hierarchical-capable" is now a proven claim, not a marketing statement.

---

## 2026-06-03 — Personal Department (PR #16)

**Milestone**: 7th (then 8th with admin) department `personal` — laptop operator.

**Capabilities added:** `read_file`, `list_dir`, `send_file`, `write_file`, `run_shell`,
`browser` (Safari automation). All writes and shell/browser are HITL-gated.

**ADR-013:** `personal` and `engineering` kept strictly separate (least-privilege).
Engineering tools have no laptop access; personal tools have no GitHub credentials.

**Safety:** `src/infra/path-guard.ts` — home-dir confinement, secrets blocked even on read.

**Metrics:** 267 tests green. Eval 13/13.

---

## 2026-06-01 — Phase B: Marketing + Sales + Prospecting (PR #5)

**Milestone**: 3 new departments — marketing, sales, jobhunt — merged.

**Marketing:** LinkedIn content (`linkedin_post` HITL-gated). Moved from comms (was causing
routing collisions). Brand validator + Claude judge gates added.

**Sales:** Cold outreach research + email drafts. ICP scoring via `search_web` + turicks-brain.
`send_email` HITL-gated. Suppression check before every send.

**Prospecting merged into research:** ICP scoring is a research mode, not a unique dept.
No separate prospecting department needed.

**Key routing fix:** `linkedin_post` → marketing ONLY. `read_emails` → comms ONLY.
Eliminating dual-department tool ownership eliminated routing ambiguity.

---

## 2026-06-01 — One-Week Sprint: All 4 Gumroad Products Assembled + turicks-web Updated

**Milestone**: Sprint complete — 4 revenue-ready digital products packaged + live website updated.

**Products shipped (ready for Gumroad listing):**
- `cinematic-web` Cinematic Premium Pack ($29) — 3 exclusive presets + AI build prompts + launch guide
- Prospecting & ICP Scoring Pack ($19) — 4 prompts, ICP rubric, n8n + LangGraph workflow guide
- Brand-Voice Critique Kit ($14) — TS + Python validators (zero deps) + LLM critique prompt + channel rules
- LangGraph Multi-Agent Starter ($34) — sanitized FounderOS skeleton, 13 tests, all architecture decisions documented

**turicks-web**: Digital Products section added to `/products` page — 4 cards with pricing, buy buttons (placeholder URLs, replace with live Gumroad after listing).

**ADR-009**: LinkedIn automation deferred — ban risk analysis complete, criteria defined for re-evaluation.

**FounderOS**: `gumroad-packs/` dir gitignored; 3 individual zips ready at project root.

**Next step (yours):** Create 4 Gumroad products, upload the 4 zip files, set prices, replace `turicks.com` placeholder URLs in `app/products/page.tsx` with real Gumroad links.

---

## 2026-06-01 — One-Week Ship Sprint Kicked Off (agency → SaaS start)

**Milestone**: First revenue motion decided + foundation bug fixed.

**Decisions** (ADR-008): Ship `cinematic-web` premium presets + FounderOS automation packs via Gumroad this week. Defer LinkedIn automation (ban risk → ADR-009 research). Defer full Cinematic Cloud SaaS (12-wk phase). Stabilize lightly.

**Done**:
- Architecture review completed (verdict: stabilize; spine solid; breadth not depth is the issue).
- Fixed tenant-leaking LLM cache key (`KEYS.llmCache` → `llm:{tenant}:{hash}`), TDD, +6 isolation tests (186 total green).
- Strategy doc + ADR-008 written; synced to turicks-brain.

**Method note**: brainstorming + architecture review + deep-research (analyst synthesis; live web re-run queued post session-reset).

---

## 2026-06-01 — Brand Guidelines + Strategic Vision Established

**Milestone**: First formal brand guidelines document created for Turicks.

**What was done**:
- Created `~/.claude/brand-guidelines/TURICKS.md` — global brand doc (voice, tone, ICP, channel rules, banned phrases, token economy rules)
- Created `docs/architecture/STRATEGIC-VISION.md` — 6-pillar strategic vision synthesising all founding instructions
- Added Brand Voice section to `governance/critique-rules.md` — agents now enforce brand rules at runtime
- Wrote ADR-006 (auth strategy: Composio internal + Google OAuth SaaS)
- Wrote ADR-007 (gateway-agnostic architecture: Telegram now, web app next)
- Started Phase 3 tracking doc: social pod + senior engineering agent

**Key decisions**:
- turicks-brain = brand/ops DB (Postgres in founderos) — kept strictly separate from personal-rag
- Token economy as Pillar 0: every agent defaults to nano tier, batch social content, Ollama for extraction
- Gateway-agnostic architecture: business logic in pods, gateways are pure transport
- Personal → SaaS pipeline: build for self first, extract when validated

**Metrics at this point**:
- Phases complete: 1A, 1B, 1C, 1D, 2A, 2B, 2C, 2D, 2E
- Agents in registry: (to fill from registry)
- Active departments: sales, engineering, marketing, prospecting
- Infrastructure: Postgres + Redis + Telegram + LangSmith

---

## Earlier Milestones

_(retroactively add from PROGRESS.md and phase docs)_

- Phase 2E (2026-05-31): Engineer agents per department — eng_engineer, sales_engineer, mktg_engineer live
- Phase 5 critical fixes (2026-05-31): Migration drift, CEO routing, graph crash, anti-sycophancy all fixed
- Phase 2D: Observability + docs
- Phase 2C: Suppression + quota safety rails, LinkedIn tools, scheduler
- Phase 2B: ProspectingPod + /prospect command
- Phase 2A: Redis + caching layer
- Phase 1D: Tests + evals
- Phase 1C: Telegram bot, HITL callbacks
- Phase 1B: Supervisor, sales pod, critic
- Phase 1A: Foundation — config, types, DB schema, infra layer
