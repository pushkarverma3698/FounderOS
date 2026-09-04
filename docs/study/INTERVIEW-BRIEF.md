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
| **3,649 tests · 332 files · $0 per run** | The full agent graph runs offline in CI. Scripted models, no paid calls | `pnpm test` |
| **97.3% recall@5 / 0.855 MRR** on hybrid retrieval, beating vector-only by 33 points on the hard slice | RAG measured, not hoped for. 35.6% of postings ask for RAG | `pnpm eval:retrieval`, 1,214 chunks |
| **`regex-routing: 0`, `kernel-purity: 0`, `gateway-imports: 0`** — CI fails if any rises | Architecture debt is ratcheted, not aspirational | `governance/architecture-baseline.json` |

**Scale, if asked:** 342 TypeScript source files / 58,141 LOC, 51 tool modules, 8 workers,
50 ADRs, 29 database tables, 1,297 ATS boards polled across 10 platforms, 911 job postings
ingested in 4 weeks.

---

## 2. The six stories

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
**Fix, proven not asserted.** The obvious fix ("read the in-flight receipts") turned out to be
only half the mechanism — a gated tool that's a step's *only* call produces zero receipts even
mid-interrupt, because every HITL tool calls `interrupt()` before doing any work. The real fix
reads a second source, the pending interrupt's own payload, and a new test drives the actual
LangGraph graph through both shapes to prove it, offline, at $0.
**Re-run live the same day.** Routing 74%→90%, tool selection 50%→96%, HITL 82%→95%, overall
**42%→85%**. The three recursion-limit failures — resolved, not just reclassified: re-run at
production's real limit (60, not the eval's silent default of 25), all three passed clean.
**Insight.** At least 15 of 25 original failures were the instrument. The corrected run still
surfaces 6 genuine, nameable gaps — a real tool-selection miss, an `admin`-over-pull pattern on
business questions, two comms/sales routing ambiguities — because fixing the instrument didn't
just raise the number, it's what made the real gaps visible for the first time.
**Where:** [`docs/EVAL-AUDIT-2026-08-28.md`](../EVAL-AUDIT-2026-08-28.md),
[`docs/EVAL.md`](../EVAL.md) §3.

> **Say this out loud in the interview:** I didn't quote the better number until I'd re-run it —
> the audit stated 61% proven / ~76% projected and refused to publish either as fact. The 85%
> that actually shipped came in higher than even the optimistic projection, which is the honest
> way to be surprised: after measuring, not instead of it.

### Story 6 — "My CV writer put Kubernetes on my résumé"

**Setup.** The job pipeline tailors my CV to each posting before I approve sending it. This is
the one place in the system where a hallucination has legal consequences, not just embarrassing
ones.
**Failure.** The only thing standing between the model and a fabricated credential was a *prompt
instruction* — "never claim skills the base CV doesn't have." The single post-generation check
was a style linter. That violates the rule the rest of this codebase is built on: guards are pure
unit-tested functions, never prompt instructions. I had written the rule and then not applied it
in the highest-stakes place in the repo.
**Measurement.** I built `verifyCvClaims()` and ran it backwards over every tailored CV that had
ever rendered in production. **6 of 6 contained claims absent from my actual CV** — Kubernetes,
C#, Domain-Driven Design, Snowflake, ETL. Zero of the 6 had been sent (`applied_at` null on all
six), so the risk was real but contained.
**The part I didn't expect.** I re-ran all 6 through the fixed pipeline. One came back clean. The
other five stayed blocked — so I read my own base CV to check whether the guard was over-firing.
It wasn't: those five postings want Python, SQL, Java, C# and .NET, and **none of those words
appear anywhere in my CV.** The guard hadn't caught a prompting problem. It had caught a
*matching* problem two stages upstream — the screener had passed jobs I don't qualify for, and
fabrication was the model's only way to satisfy an impossible instruction.
**Insight.** A guard that keeps firing is telling you something about the system above it. If I
had "fixed" this by loosening the check, I'd have hidden a screening bug behind a résumé that
lied.
**Mechanism.** `verifyCvClaims()` — pure, deterministic, $0, 11 unit tests, checks five claim
types (technologies, employers, titles, dates, degrees) against the base CV and blocks the output
rather than warning about it.
**Where:** `src/tools/jobhunt/cv-claim-guard.ts`,
[PORTFOLIO-GAPS-AND-ACTIONS.md](PORTFOLIO-GAPS-AND-ACTIONS.md) P0-1.

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
Four layers: 3,649 offline behavioural tests at $0 with scripted models; a determinism gate that
requires byte-identical plans across two threads; a 41-task golden set on a live model; and a
retrieval ablation with recall@5/MRR. Then volunteer Story 5 — that the golden set had a bug and
I published the audit.

**"What's broken right now?"**
Have the list ready, it reads as strength. Four things, none of them hidden:

1. **Six source files over my own 400-line CI budget and 11 untagged fail-open catches.** Both
   are *counted in CI and allowed only to shrink* — `src/db/queries.ts` is 2,233 lines and sits
   on the checkpointer's hot path, so I did not split it under time pressure.
2. **The golden set is not in CI** — it costs money, so it runs manually, so a behavioural
   regression can reach `main` between runs. The honest middle path (weekly schedule, report
   committed) is written down and not yet built.
3. **Six genuine eval failures** at 85%, each nameable: one real tool-selection miss, an
   `admin`-over-`pull` routing pattern on business questions, two comms/sales ambiguities.
   These only became visible *after* I fixed the harness — the broken instrument was hiding them.
4. **Python.** 70% of the postings I measured ask for it; this is TypeScript. Closing it with a
   Python client for the MCP surface, not a rewrite.

`docs/LIMITATIONS.md` lists all of them by ID with severities.

*Two things that were on this list yesterday and are not any more, worth saying because the
mechanism is the point:* the eval harness defects (fixed and re-run, Story 5) and a CV tailoring
guard that was a **prompt instruction rather than a pure function** — a direct violation of my
own architecture rule, in the one place a hallucination has legal consequences. It is now
`verifyCvClaims()`, a pure unit-tested function. See Story 6.

**"You built this alone — how do I know you can work in a team?"**
The repo runs a written operating contract: every change goes through a PR to `beta` with a
merge gate, an adversarial review step that must produce one of four explicit verdicts, 50 ADRs
recording why decisions were made, and session records under `docs/sessions/`. The process
exists precisely so the reasoning survives the author.

---

## 4. The 60-second path for a recruiter

Give them this order and nothing else:

1. **[README.md](../../README.md)** — the architecture diagram and the six numbers
2. **[docs/EVAL.md](../EVAL.md)** — how it's evaluated, with published results
3. **[docs/LIMITATIONS.md](../LIMITATIONS.md)** — what's broken, by ID
4. **[docs/decisions/README.md](../decisions/README.md)** — 50 ADRs, the 10 most relevant first

If they only click one, it should be `docs/EVAL.md`: it's the one that shows measurement rather
than assertion, and per the market data, evaluation is asked for by 36.2% of AI-track postings.

---

## 5. Positioning, in one paragraph

> I build agent systems that survive production. FounderOS is a deterministic, contract-first
> LangGraph kernel that has taken 80 real actions — emails, LinkedIn posts, GitHub issues, shell
> commands, a job application — behind 229 human approvals, 36 of which I rejected. Every action
> claim requires a receipt, so it can't report work it didn't do. Retrieval is hybrid pgvector +
> keyword fusion measured at 97.3% recall@5. The whole graph runs offline in 3,649 tests at $0,
> and CI enforces an architecture-debt ratchet that can only shrink. I shipped it three times
> before I shipped it right, and the autopsies are in the repo.

Target the roles that ask for **agents + evaluation + production** — 20% of AI postings, and a
much narrower field than the 61% that merely say "agent."
