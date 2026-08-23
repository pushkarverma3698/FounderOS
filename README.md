# FounderOS

**Building Production-Grade AI Systems**

Everything in this repository exists because I wanted to answer one question: *how do you build AI systems that survive production?*

FounderOS is a deterministic, contract-first agent kernel that takes real business actions — email, LinkedIn, GitHub, shell — safely, with founder approval and a code-recorded receipt for every one. It runs my studio ([Turicks](https://turicks.com)) end-to-end over Telegram. But the interesting part isn't what it does — it's the engineering problems I had to solve to make it reliable.

[![CI](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-3%2C465%20offline%20%240-brightgreen.svg)](https://github.com/pushkarverma3698/FounderOS/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Why This Exists

I shipped this system three times before I shipped it right.

**v1** was a 10,678-line hand-rolled orchestrator. An audit found that 4 of 5 departments wrote audit-log rows but never called the tool — every approval the founder gave produced a database entry, not a sent email.

**v2** replaced it with framework primitives and claimed "~500 LOC." A zero-base audit found **27,819 LOC**, three competing routers (two regex piles + one LLM), and a 591-line "lie detector" that rewrote its own Postgres history when it got a false positive.

**v3** deleted two of the three routers, replaced detection with prevention, and made CI enforce that the complexity can't creep back. The full autopsy — including where I fell for AI slop and how I dug out — lives in [the case studies](docs/turicks-case-studies/).

---

## Production Problems Solved

| Problem | Mechanism | Evidence |
|---------|-----------|----------|
| **State persistence** | Postgres-checkpointed graph; approval rows written *before* `interrupt()` | Crash mid-approval → restart → pending action survives |
| **Zero-hallucination actions** | `ToolReceipt` required for every action claim; synthesizer only sees validated results | `kernel-e2e: fabricated action` — unproven claims rejected |
| **Crash-safe human-in-the-loop** | Durable record before interrupt; idempotency key before every send | Process crash during approval → no double-send, no lost state |
| **Deterministic evaluation** | Temp 0, scripted models offline, pure-function routing | 3,465 tests at $0; byte-identical plans asserted in CI — [how this is evaluated](docs/EVAL.md) |
| **Architecture-debt ratchet** | CI-enforced baseline that may only shrink | `regex-routing = 0`, `gateway-imports = 0`, `kernel-purity = 0` |
| **Idempotent side effects** | Dedup key checked before every external send | Retry can never double-send an email |
| **Typed failure taxonomy** | `FailureReport` = stage + component + evidence + retryable | Threads never silently wiped; founder always sees the real error |
| **Anti-slop CI gates** | Tombstones, import-direction rules, 400-LOC budget | Deleted modules fail CI if recreated |
| **Wedge-thread recovery** | `isWedgedState` predicate + auto-recovery guard | Stuck checkpoints detected and cleared before invoke |
| **Tool wiring verification** | `verify-wiring.ts` in CI | Half-wired tools caught at build, not at runtime |

---

## Engineering Challenges

### Challenge 1: How do you stop multi-agent systems from becoming impossible to debug?

**The problem.** v2 had three control systems per message: a 9-regex pre-router that mutated the task before any agent saw it, an 11.5 KB LLM supervisor prompt, and a 77-regex post-hoc "lie detector." The system's real behavior was the *intersection* of all three, and nobody could hold that in their head. Every production incident was "fixed" by adding a fourth layer.

**The solution.** One typed pipeline: `plan → dispatch → agent ⇄ tools → collect → synthesize`. The supervisor is pure code, not an LLM — given a `Plan` and a cursor it deterministically emits the next `TaskEnvelope`. Routing is a set of pure functions with unit tests, not regex claims or prompt instructions.

**Why it stays fixed.** CI enforces **tombstones** — `pre-router.ts`, `execution-guard.ts`, and `office.ts` fail the build if recreated. An architecture-debt ratchet holds `regex-routing` at `0` and only lets it shrink. A 400-line-per-file budget kills god modules before they form.

*Full story: [The Three-Router Trap](docs/turicks-case-studies/01-three-router-trap.md)*

---

### Challenge 2: How do you prevent agents from claiming actions they didn't take?

**The problem.** v1's finalize node wrote an audit-log row and returned — it never called the tool. Every "✅ Email sent" was a lie with a database row to "prove" it. v2 tried to catch lies after the fact with 77 regexes. False positives cost 2× LLM spend (full graph re-invoke) and the guard *rewrote its own Postgres history* on a regex verdict.

**The solution.** Deleted the lie detector entirely. Every tool execution now emits a code-recorded `ToolReceipt` — written by the adapter, not the model. A step's `StepResult` is validated by `validateStepResult` (a pure function). An action step with no successful receipt is a terminal, typed failure. The synthesizer only ever sees validated results — it's physically incapable of claiming an action with no receipt behind it.

**The engineering principle.** Detection scales linearly with every incident (+1 regex per bug). Prevention is a one-time structural cost. If your safety mechanism gets bigger every sprint, it's the wrong mechanism.

*Full story: [The Lie Detector We Built for Our Own AI](docs/turicks-case-studies/02-lie-detector-for-our-own-ai.md)*

---

### Challenge 3: How do you recover after a crash mid-approval?

**The problem.** External side effects (send email, post to LinkedIn, create GitHub issue) need human approval. But if the process crashes while awaiting approval, the pending action must survive the restart — and a retry must never double-send.

**The solution.** The durable record is written to Postgres **before** `interrupt()`, not after. If the process dies, the approval row is already there. On resume, an idempotency check (`hasBeenAudited`) runs before every send. The audit row is written only on real success. Rejection clears the thread and confirms — it **never** resumes into the agent (this was a bug I found and fixed: [SF-6](#mistakes-i-made)).

**The contracts.**
- `hitl_approvals` row → written BEFORE interrupt
- `action_log` row → written AFTER successful execution
- Idempotency key → checked BEFORE every external send

*Full flow with edge cases: [HITL approval flow (diagram 03)](docs/diagrams/03-hitl-flow.md)*

---

### Challenge 4: How do you test agents without spending money?

**The problem.** Live LLM calls are slow, expensive, and non-deterministic. You can't run a meaningful test suite against a paid API in CI.

**The solution.** The kernel is a library — models, tools, and the checkpointer are injected. [`kernel-boot.ts`](src/gateway/kernel-boot.ts) is the only composition root. This lets the full orchestration graph run offline in CI with scripted models at **$0**. Temperature 0 + deterministic dispatch means CI can run the golden set twice and assert byte-identical plans.

**The evaluation tiers:**

| Tier | What | Cost | When |
|------|------|------|------|
| `pnpm test` | 3,465 unit/kernel tests across 317 files, scripted models | $0 | Every commit |
| `pnpm eval` | 46 golden tasks, 3 scoring dimensions (routing · tools · HITL) | ~$0.10 | Per feature branch |
| `pnpm qa:telegram` | 22-task MTProto founder-simulation against live bot | ~$0.50 | Pre-deploy acceptance |

**What the eval catches:** routing misclassification (e.g., "draft cold outreach + research first" routed to `research` instead of `sales`), tool drops (LinkedIn post planned but no tool called), unnecessary HITL triggers on read-only tasks, and complete routing failures.

*Method — what is scored and what is not: [docs/EVAL.md](docs/EVAL.md) · Scoreboard: [PROOF.md](docs/PROOF.md) · Last recorded run: [EVAL.md](EVAL.md) (2026-06-11, pre-v3 — regenerate with `pnpm eval`)*

---

### Challenge 5: How do you stop AI-generated code from rotting your codebase?

**The problem.** AI coding agents are fast. Speed with no discipline compounds into **AI slop** — plausible, confident, over-engineered code that passes review and fails production. v2 claimed "~500 LOC" and measured 27,819.

**The solution.** Five CI-enforced architecture rules ([`verify-architecture.ts`](scripts/verify-architecture.ts)):

1. **Tombstones** — killed modules fail CI if recreated
2. **Ratchet** — architecture debt may only shrink (current: all zeros)
3. **Import direction** — `contracts ← kernel ← gateway`; the kernel imports only kernel/core/db/infra/tools
4. **LOC budget** — no `src` file over 400 lines
5. **Fail-open catches** — need an explicit `// allow-failopen: <reason>` tag

**The principle.** The v2 system decayed because nothing stopped complexity from creeping back. v3 makes architecture a thing CI can fail a PR over.

*Full playbook: [Working With AI Agents Without Slop](docs/turicks-case-studies/05-working-with-ai-agents-without-slop.md)*

---

## Architecture Decisions

| Decision | Why | Tradeoff |
|----------|-----|----------|
| **LangGraph** over custom orchestration | Resumability, deterministic state, checkpoint support, graph inspection | Vendor coupling to LangChain ecosystem |
| **Postgres** over Redis for state | Crash-safe HITL requires durable writes *before* interrupt; Redis doesn't survive restart by default | Higher latency than Redis for hot-path reads |
| **Pure-code supervisor** over LLM router | Deterministic, testable, no prompt drift, auditable routing | Less flexible than LLM-based routing for ambiguous tasks |
| **Temperature 0** everywhere | CI can assert byte-identical plans; eval results are reproducible | Loses creative variation; Gemini still has minor non-determinism at temp 0 |
| **Single-tenant polling** over webhooks | Simpler, no 409 conflicts, adequate for one founder | Hard horizontal scaling ceiling (acknowledged in [LIMITATIONS.md](docs/LIMITATIONS.md)) |
| **Zod contracts at every boundary** | Mismatches are terminal typed failures, not silent corruption | Strict validation rejects edge cases a permissive system would handle |
| **Gemini Flash** at temp 0 | Fast, cheap, clean tool-calls; fallback chain in [`model.ts`](src/agents/model.ts) | Weaker routing on ambiguous multi-department tasks vs. frontier models |

---

## Mistakes I Made

These are the bugs that mattered most. Each one passed the unit suite while failing in production — because the test suite exercised the kernel directly and never touched the real Telegram gateway run-loop. Full log: [SEAM-FAILURES.md](docs/SEAM-FAILURES.md).

### Bug: Wedged-thread infinite loop (SF-3)

A run aborted mid-graph (recursion limit / budget / crash) left the thread parked on a pending node with **0 interrupts**. Every later message *resumed* the stuck node → looped to the recursion limit. The founder got nothing; only `/reset` fixed it.

**Diagnosis:** `scripts/probe-real-task.ts` — a fresh thread always worked, the live thread looped.
**Fix:** `isWedgedState` predicate + `recoverWedgedThread` guard clears the bad checkpoint before a fresh invoke. 4 regression tests.
**Prevention:** Wedge guard runs at the top of every `runOfficeText`.

### Bug: HITL reject-loop (SF-6)

Rejecting an approval card looped — the ReAct agent treated the rejection tool-result as feedback and re-drafted forever, firing `interrupt()` again. Live MTProto repro 2026-06-12.

**Fix:** The reject path clears the thread and confirms; it **never** resumes into the agent. `buildRejectionConfirmation` + early return in `resumeOffice`. 4 regression tests.

### Bug: False "Tool issue" on successful results (SF-1)

A successful tool result whose first line contained a keyword like "error" or "failed" was classified as a failure. The founder saw a spurious "⚠️ Tool issue" banner on a reply that actually worked.

**Fix:** `isToolFailure()` now requires a structured failure flag OR a first-line keyword — not a substring anywhere. Pure predicate with unit tests.

### Architecture mistake: The 77-regex lie detector

Built a 591-line, 68-export regex guard to verify the AI actually performed actions. It grew by +1 regex per incident, its false positives cost 2× LLM spend, and it **rewrote Postgres history** on a regex verdict. Replaced with structural receipts that make lying impossible by construction. It's now a CI tombstone — recreating the file fails the build.

*The full narrative: [case studies 01–04](docs/turicks-case-studies/)*

---

## Tradeoffs I Chose

Honest accounting of what's deferred, from [LIMITATIONS.md](docs/LIMITATIONS.md):

- **6-layer tool wiring chain (HIGH):** Adding one tool touches 6 files in lockstep with no compile-time enforcement that they stay in sync. Partly mitigated by `capabilities.ts` as single source of truth + CI wiring verification. Full registry codegen deferred until contributor count grows.
- **Single-instance polling gateway (MEDIUM):** Cannot run two instances; hard horizontal scaling ceiling. Fine for single-tenant (one founder). Multi-tenant SaaS will require webhooks + per-tenant thread isolation.
- **Config validates presence, not validity (MEDIUM):** `config.ts` checks env keys exist (Zod), not that they work. A stale API key passed startup and failed on the first real call. Startup smoke-call deferred behind a `--skip-smoke` flag for CI.
- **Eval non-determinism at temp 0 (LOW):** Even at temperature 0, `pnpm eval` scores 79–90% across runs due to Gemini capacity noise. The durable guarantee is the deterministic unit suite, not the eval percentage.

---

## Observability

Every boundary in the run-loop emits a structured **seam event**: `turn.in`, `route.decided`, `tool.call`, `tool.result`, `tool.error`, `hitl.*`, `halt.blocked`, `wedge.recovered`, `turn.out`. Turn-level tracing captures the full lifecycle from message receipt to reply. The [SEAM-FAILURES.md](docs/SEAM-FAILURES.md) log records every production bug traced to a seam boundary, with signature → evidence → fix → prevention.

---

## Quick Start

```bash
git clone https://github.com/pushkarverma3698/FounderOS.git && cd FounderOS
pnpm install
cp .env.example .env          # fill in DATABASE_URL, TELEGRAM_BOT_TOKEN, GOOGLE_GENERATIVE_AI_API_KEY
docker compose up -d postgres
pnpm run setup                # Drizzle migrations + checkpointer tables (NOT pnpm setup — that's a built-in)
pnpm dev
```

**Commands:**

| Command | What |
|---------|------|
| `pnpm test` | Deterministic suite, $0, scripted models |
| `pnpm lint && pnpm verify:arch` | Types + anti-slop gates |
| `pnpm gate` | Full merge gate (lint + build + wiring + arch + test) |
| `pnpm eval` | Live golden-set eval (paid — run once per feature) |
| `pnpm qa:telegram` | 22-task MTProto founder-simulation (production acceptance) |

---

## Deep Dives

| Document | What you'll find |
|----------|-----------------|
| [Case Studies: v1→v2→v3](docs/turicks-case-studies/) | 5 engineering war stories, including the 77-regex lie detector and the empty-braces handoff |
| [**How this system is evaluated**](docs/EVAL.md) | What is scored and what is not: determinism in CI, the golden set, retrieval recall@5/MRR, and why an infra error is never a routing miss |
| [Seam Failures Log](docs/SEAM-FAILURES.md) | 6 production bugs with signature → evidence → fix → prevention |
| [Architecture Diagrams (10)](docs/diagrams/) | Mermaid diagrams grounded in source, with file paths linked inline |
| [Proof Scoreboard](docs/PROOF.md) | Regenerable evidence: kernel guarantees, debt ratchet, cost ledger |
| [Limitations & Tech Debt](docs/LIMITATIONS.md) | Honest accounting of scaling ceilings, deferred work, and accepted risks |
| [JARVIS Architecture](JARVIS-ARCHITECTURE.md) | The v3 contract-first kernel design spec |
| [Zero-Base Audit](ZERO-BASE-AUDIT.md) | 4 live failure traces from the v2→v3 rebuild |
| [Architecture Ledger](ARCHITECTURE_LEDGER.md) | Timestamped log of every major architecture decision |

---

## Tech Stack

| Layer | Choice | Why this and not the alternative |
|---|---|---|
| Orchestration | [LangGraph JS](https://github.com/langchain-ai/langgraphjs) `StateGraph` | Resumability + checkpoints + graph inspection. No `createSupervisor` — the supervisor is pure code. |
| LLM | Gemini Flash, temp 0 | Fast, cheap, clean tool-calls. Fallback chain in [`model.ts`](src/agents/model.ts). |
| Checkpointer | `@langchain/langgraph-checkpoint-postgres` | Crash-safe HITL requires durable state that survives process death. |
| Gateway | [grammY](https://grammy.dev/) | Telegram transport; inline Approve/Reject keyboards for HITL. |
| Database | PostgreSQL + [Drizzle ORM](https://orm.drizzle.team/) | Type-safe migrations; `agents` + `brain` schemas. |
| Language | TypeScript strict, Node 22 ESM | End-to-end type safety across kernel ↔ gateway ↔ tools. |

---

Built by [Pushkar Verma](https://www.linkedin.com/in/pushkarverma3698/).

## License

MIT — see [LICENSE](LICENSE)
