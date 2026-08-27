# Interview brief — the numbers and the stories

*2026-08-28. Every number verified against production or the repo on this date. If a number
here can't be reproduced by a command or a query, it doesn't belong in this file.*

---

## 1. The numbers, above the fold

Use these six. They are specific, verifiable, and each one implies a mechanism.

| number | what it proves | source |
|---|---|---|
| **229 human approvals in production — 131 approved, 36 rejected** | The HITL gate is real and has *blocked* things. 7.3% of AI postings ask for HITL | `agents.hitl_approvals`, 2026-06-16 → 2026-08-27 |
| **80 real side effects executed** — 24 shell runs, 13 code sessions, 11 GitHub issues, 6 LinkedIn posts, 6 emails, 1 job application, 1 site deploy | It takes real actions, not demo actions | `agents.action_log` |
| **1,843 LLM calls · $2.53 total · $0.001373 mean · 8 models** | Per-call cost attribution in production. 6.8% of postings ask for cost optimisation | `agents.ai_call_costs`, 2026-07-04 → 2026-08-24 |
| **3,611 tests · 337 files · $0 per run** | The full agent graph runs offline in CI. Scripted models, no paid calls | `pnpm test` |
| **97.3% recall@5 / 0.855 MRR** on hybrid retrieval, beating vector-only by 33 points on the hard slice | RAG measured, not hoped for. 35.6% of postings ask for RAG | `pnpm eval:retrieval`, 1,214 chunks |
| **`regex-routing: 0`, `kernel-purity: 0`, `gateway-imports: 0`** — CI fails if any rises | Architecture debt is ratcheted, not aspirational | `governance/architecture-baseline.json` |

**Scale, if asked:** 334 TypeScript source files / 57,688 LOC, 51 tool modules, 8 workers,
51 ADRs, 20 database tables, 623 ATS boards polled, 911 job postings ingested in 4 weeks.

---

## 2. The five stories

Each is a real incident with a mechanism as the punchline. Lead with the failure — hiring
managers screen for people who have *watched agents fail in production*, and one posting in this
dataset (Aera Technology) says so almost verbatim.

### Story 1 — "Three of my departments logged actions they never took"

**Setup.** v1 was a 10,678-line hand-rolled orchestrator.
**Failure.** An audit found 4 of 5 departments wrote an audit-log row but never called the tool.
Every approval the founder granted produced a database entry instead of a sent email.
**Insight.** The system could *claim* an action it hadn't performed, because the claim and the
action were separate code paths.
**Mechanism.** In v3 an action claim requires a successful `ToolReceipt` (`validateStepResult`),
and the synthesizer is fed **only validated results** — never raw tool output. Fabrication
becomes structurally impossible rather than discouraged.
**Where:** `src/kernel/contracts.ts`, `ZERO-BASE-AUDIT.md`.

### Story 2 — "My lie detector rewrote its own history"

**Setup.** v2 was rebuilt on framework primitives and documented as "~500 LOC."
**Failure.** A zero-base audit measured **27,819 LOC**, three competing routers (two regex piles
plus one LLM), and a 591-line "lie detector" that, on a false positive, **rewrote its own
Postgres history**.
**Insight.** Detection layered on top of a broken design is more surface area, not less risk.
**Mechanism.** v3 deleted two of the three routers and replaced detection with prevention:
routing is a pure, unit-tested function, and CI **tombstones** the deleted modules so they fail
the build if re-created. `regex-routing: 0` is enforced, not documented.
**Where:** `ZERO-BASE-AUDIT.md`, `scripts/verify-architecture.ts`.

### Story 3 — "It clicked Submit before asking me"

**Setup.** The job pipeline's `submit_application` tool drives a real browser through real
application forms.
**Failure.** Found in live Telegram QA on 2026-08-24: it clicked the real Submit button
**before** the HITL approval fired. Unit tests were green.
**Insight.** The bug lived at a **seam** the tests never crossed — the kernel was tested
directly, so nothing exercised gateway → kernel → tool → real form.
**Mechanism.** Fixed, deployed and live-re-verified the same day. The ordering rule is now
explicit and pinned per tool: durable DB row → `interrupt()` → approval → idempotency-key check
→ side effect → audit row **only on real success**. Seven live Playwright/HITL bugs were found
this way, none by the unit suite.
**Where:** `docs/EVAL.md` §5, `SEAM-FAILURES.md`, `src/infra/hitl.ts`.

### Story 4 — "I measured reranking and threw it away"

**Setup.** Reranking is the obvious next step for any RAG system and it was already built.
**Measurement.** Hybrid + rerank scored MRR 0.885 vs 0.855 — better at ranking — but **dropped
disjoint recall by 8.4 points** and cost **9,579ms p95 versus 241ms**, 40×, for a query that
runs inline in a Telegram reply.
**Decision.** Rejected. It ships in the codebase behind `RAG_RERANK=false`.
**Insight.** The ablation harness is the deliverable. Without it this would have shipped on
vibes, because it *sounds* like an improvement.
**Where:** `docs/EVAL.md` §4, `src/db/rag-rerank.ts`, `scripts/run-retrieval-eval.ts`.

### Story 5 — "My eval was measuring my eval"

**Setup.** The 41-task golden set scored 42% overall, 50% on tool selection.
**Investigation.** The report contradicted itself on nine rows: it recorded `hitl ✅` — proving a
tool-internal approval gate had fired — and `tools: [none]` on the same task. Cause: the eval
invoker reads receipts only from *settled* steps, and a step that pauses at `interrupt()` never
settles. A HITL-heavy agent was being measured by an instrument blind to HITL.
**Also found, in the other direction.** `isInfraError` treated *any* thrown error as a provider
outage, so three genuine recursion-limit crashes were excluded from scoring. The number was
flattered as well as deflated — and that is written down too.
**Insight.** At least 15 of 25 failures were the instrument. Six were the agent.
**Where:** [`docs/EVAL-AUDIT-2026-08-28.md`](../EVAL-AUDIT-2026-08-28.md).

> **Say this out loud in the interview:** the corrected numbers are stated there as *projected*,
> not published, because they haven't been earned by a re-run yet. Refusing to quote your own
> better number until it's measured is the point of the story.

---

## 3. Questions to expect, and the honest answer

**"Why TypeScript and not Python?"**
Straight answer: the system is a long-running stateful orchestration service with a Telegram
transport, so end-to-end type safety at every boundary mattered more than library breadth —
Zod validates every contract and CI enforces it. Then concede the real point: **70% of AI
postings ask for Python and 16% ask for TypeScript**, I measured that from 177 postings my own
pipeline collected, and I'm closing it with a Python client for the MCP surface. Don't be
defensive; the measurement *is* the answer.

**"Is this just a wrapper around LangChain?"**
No — and the distinction is the whole design. There is no LLM supervisor. The planner emits a
Zod-validated `Plan`, and dispatch is **pure code** that walks `plan[cursor]` into a
`TaskEnvelope`. LangGraph provides the StateGraph and the Postgres checkpointer; the routing,
guards and validation are unit-tested pure functions. I also fixed a bug upstream in
LangGraph.js — `maxConcurrency:1` silently dropped `Send` fan-out ([PR
#2665](https://github.com/langchain-ai/langgraphjs/pull/2665)).

**"How do you know it isn't hallucinating actions?"**
It structurally can't claim one. An action claim requires a successful `ToolReceipt`; the
synthesizer never sees raw tool output. That mechanism exists because v1 shipped the opposite
and I audited it — Story 1.

**"How do you evaluate it?"**
Four layers: 3,611 offline behavioural tests at $0 with scripted models; a determinism gate that
requires byte-identical plans across two threads; a 41-task golden set on a live model; and a
retrieval ablation with recall@5/MRR. Then volunteer Story 5 — that the golden set had a bug and
I published the audit.

**"What's broken right now?"**
Have the list ready, it reads as strength: the eval harness defects (audited, being fixed), an
unbounded worker loop that hits LangGraph's recursion limit on very broad research tasks, six
files over the 400-line budget and 11 untagged fail-open catches — **both counted in CI and
allowed only to shrink** — and a CV tailoring guard that is currently a prompt instruction
rather than a pure function, which violates my own rule and is the next thing I'm fixing.
`docs/LIMITATIONS.md` lists them by ID.

**"You built this alone — how do I know you can work in a team?"**
The repo runs a written operating contract: every change goes through a PR to `beta` with a
merge gate, an adversarial review step that must produce one of four explicit verdicts, 51 ADRs
recording why decisions were made, and session records under `docs/sessions/`. The process
exists precisely so the reasoning survives the author.

---

## 4. The 60-second path for a recruiter

Give them this order and nothing else:

1. **[README.md](../../README.md)** — the architecture diagram and the six numbers
2. **[docs/EVAL.md](../EVAL.md)** — how it's evaluated, with published results
3. **[docs/LIMITATIONS.md](../LIMITATIONS.md)** — what's broken, by ID
4. **[docs/decisions/README.md](../decisions/README.md)** — 51 ADRs, the 10 most relevant first

If they only click one, it should be `docs/EVAL.md`: it's the one that shows measurement rather
than assertion, and per the market data, evaluation is asked for by 36.2% of AI-track postings.

---

## 5. Positioning, in one paragraph

> I build agent systems that survive production. FounderOS is a deterministic, contract-first
> LangGraph kernel that has taken 80 real actions — emails, LinkedIn posts, GitHub issues, shell
> commands, a job application — behind 229 human approvals, 36 of which I rejected. Every action
> claim requires a receipt, so it can't report work it didn't do. Retrieval is hybrid pgvector +
> keyword fusion measured at 97.3% recall@5. The whole graph runs offline in 3,611 tests at $0,
> and CI enforces an architecture-debt ratchet that can only shrink. I shipped it three times
> before I shipped it right, and the autopsies are in the repo.

Target the roles that ask for **agents + evaluation + production** — 20% of AI postings, and a
much narrower field than the 61% that merely say "agent."
