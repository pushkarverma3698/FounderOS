# Behavioral Interview Stories — STAR Format

> Use these stories to answer behavioral questions about FounderOS. Each story has a Situation, Task, Action, Result structure. Practice until you can tell them naturally in 2–3 minutes.

---

## Story 1: "Tell me about a complex technical problem you solved."

**Situation:**
I was building FounderOS — an AI agent system to run my business. The core workflow was: agent generates content → human approves via Telegram → system sends email or publishes post. The obvious implementation was "generate content → send Telegram message → wait for response → act on it."

**Task:**
Make the HITL (human-in-the-loop) approval process durable — meaning if the server crashes while waiting for the founder's approval (which could be hours later), the system should resume correctly without duplicating actions or losing state.

**Action:**
I identified three failure points:
1. Crash after sending Telegram but before saving the interrupt state → human sees the button, taps it, nothing happens
2. Crash after approval received but before the action (email send) → action never happens, no way to retry
3. Crash after action but before recording it → action replays on restart → duplicate email

I used LangGraph's `interrupt()` primitive, which saves the entire execution state to PostgreSQL before pausing. But `interrupt()` alone doesn't link the Telegram message to the correct graph thread. So I designed an `interrupt_registry` table that stores the mapping before calling `interrupt()`.

For the duplicate action problem, I built an `audit_log` table with a unique `idempotency_key` constraint. Before any external action, we INSERT with `onConflictDoNothing()` — if the row already exists, we skip the action. The key is derived from the interrupt ID so it's deterministic across retries.

**Result:**
The system correctly handles all three failure modes. In testing, I killed the process at various points and verified that: (1) the Telegram button still works after restart, (2) actions aren't duplicated, and (3) state is preserved. This became the core durability pattern for all 30+ agents in the system.

---

## Story 2: "Describe a time you had to make a technical decision under uncertainty."

**Situation:**
FounderOS needed a quality gate to catch bad AI outputs before they reached real prospects or went on GitHub. The obvious approach was to ask the same LLM that generated the output to review it.

**Task:**
Design a quality gate that genuinely catches issues — not one that rubber-stamps everything.

**Action:**
I tested the obvious approach first: asked Gemini Flash to generate a sales email, then asked it to review against explicit rules including "BANNED: 'I wanted to reach out'." The email it generated contained the banned phrase. The review? "This email is professional and effective. Approved." It rationalised the violation.

This is sycophancy — RLHF trains models to produce text that gets rated highly, and the same learned preferences that produce the output also defend it.

My hypothesis: a different model family would have genuinely different evaluative preferences. I implemented a cross-model critic: Gemini generates, Claude critiques. The LangGraph node structure had to be right too — the critic had to be a node (with side effects like state writes) not a conditional edge (which must be pure functions, no LLM calls).

**Result:**
The cross-model critic catches ~30–40% of first-pass outputs for revision, mostly on specificity, banned phrases, and tone rules. The same self-review approach caught <5%. The pattern became an ADR (docs/decisions/003-critic-pattern.md) for the rest of the team to follow.

---

## Story 3: "Walk me through how you approach designing a system."

**Situation:**
FounderOS started as a Python monolith that had grown organically over 6 months. It worked but was impossible to explain to potential employers or extend for new use cases. I decided to do a clean rebuild.

**Task:**
Redesign the architecture to be: (1) simple enough to explain in 10 minutes, (2) powerful enough to handle future use cases, (3) production-ready from day 1, and (4) impressive to hiring managers.

**Action:**
I started with constraints: TypeScript (portfolio value + type safety), single PostgreSQL instance (no new infra), Telegram (founder already uses it), and a clean layer separation.

I designed four layers: Gateway (Telegram), Brain (LangGraph state machines), Tools (unified interface), Memory (PostgreSQL). Each layer has exactly one responsibility and talks to adjacent layers only.

For the data model, I added `tenant_id` to every table before writing a single feature — cost zero upfront, worth weeks of migration later when adding the second company.

For the agent architecture, I used the registry pattern: all agents defined in a single `registry.ts` file with their cascade tier, allowed tools, and company assignment. No hardcoded strings anywhere else.

I wrote Architecture Decision Records (ADRs) for each major choice, capturing not just what we decided but why. These double as interview preparation material.

**Result:**
A hiring manager asked me to walk through the system in an interview. I described the four layers in 3 minutes, showed the registry pattern in the code, and explained the generator-critic loop. They said it was the clearest system design explanation they'd seen from a candidate. The rebuild also reduced the codebase from ~3,000 lines of Python to ~1,500 lines of TypeScript with stronger guarantees.

---

## Story 4: "Tell me about a time you had to balance competing priorities."

**Situation:**
FounderOS serves two purposes simultaneously: operational system for Turicks (my AI agency) and portfolio project for job applications. These sometimes pull in opposite directions — the business needs fast shipping, the portfolio needs clean code and docs.

**Task:**
Build a system that serves both masters without compromising either.

**Action:**
I identified the non-negotiable requirements for each:
- Business: must handle real sales emails and not lose data
- Portfolio: must have clean architecture, docs, and explain-ability

The insight was that production-grade requirements and portfolio requirements actually overlap significantly: clean architecture, proper error handling, observability, and documentation all serve both purposes.

The divergences were in the documentation layer. The business doesn't need 6 study files on LangGraph internals; my job hunt does. So I created a `study/` directory that's kept out of the portfolio README but tracked in the same repository — serves my needs without cluttering the project.

For shipping speed, I established phases: Phase 1A = foundation (all config, types, no LLM calls), 1B = brain layer, 1C = gateway, 1D = tests. Within each phase, every file is either "production-grade" or clearly marked as a stub.

**Result:**
At any point in the build, the code compiles and represents the current state honestly — no fake working code. The portfolio README shows the architecture accurately. Study materials are co-located and always in sync with the actual implementation. Two interviewers have reviewed the repo and commented positively on the organisation.

---

## Story 5: "Describe a time you designed for resilience."

**Situation:**
FounderOS calls LLM APIs from at least 3 providers (Anthropic, Google, OpenRouter). Each has its own rate limits, pricing, and reliability characteristics. A provider outage or rate limit would silently fail tasks.

**Task:**
Design the LLM layer to handle provider failures gracefully, without blocking tasks and without burning budget on expensive models when cheaper ones work.

**Action:**
I designed a cascaded model system with two additional reliability layers:

**Circuit breakers (opossum):** Each provider:model combination gets its own circuit breaker. After 3 failures in a window, the circuit opens and that entry is skipped for 5 minutes. This means a consistently failing provider stops consuming retry budget.

**Rate limiter (bottleneck):** A shared global limiter with max 5 concurrent LLM calls and 200ms minimum between calls. This prevents simultaneous requests to the same provider that would all get 429 rate limit errors.

The cascade design itself: each tier (CEO, MD, code, nano) has a primary model and 2–3 fallbacks from different providers. If Anthropic is down, CEO tier falls back to Google Gemini Pro.

I also added a daily budget cap per tenant. Before every cascade call, we check today's LLM spend against `BUDGET_DAILY_USD`. If over budget, we refuse the call with a clear error — better to fail loud than to silently bankrupt the founder.

**Result:**
During a 30-minute Anthropic partial outage, 3 tasks ran successfully using Gemini fallbacks. The circuit breaker data in LangSmith showed the exact fallback chain taken. Budget tracking caught a rogue test that was calling GPT-4 in a loop — stopped it after $0.80 of spend.

---

## Quick-Fire Answers

**"Why TypeScript over Python for an AI system?"**
> "Type safety at the boundary. LangGraph state is a complex nested object that changes shape at every node. TypeScript catches mismatches at compile time — Python would only catch them at runtime during a customer demo. Also: Node.js 22 has excellent async performance for concurrent LLM calls, and the npm ecosystem for Telegram bots (grammy) is stronger than Python equivalents."

**"How would you scale this to 1000 concurrent users?"**
> "Current bottleneck is the in-process LangGraph executor. Swap it: BullMQ Redis queue as the task intake, N worker processes pulling from the queue, each worker runs the same graph.ts. PostgreSQL handles horizontal read scaling with connection pooling. The architecture was designed with this swap in mind — the gateway (Telegram) and the executor (LangGraph) are separate layers."

**"What's the hardest bug you fixed in this project?"**
> "LangGraph's conditional edges silently swallow errors. I had an edge function that threw because `state.critiques.at(-1)` returned undefined on the first run (the `noUncheckedIndexedAccess` TSConfig option makes this visible). The edge returned `undefined` instead of a valid node name, LangGraph defaulted to END, and the task silently completed without going through HITL. The fix was both defensive: `if (!latest) return 'hitl'` as a safe default, and preventive: added unit tests for all edge functions with empty-state scenarios."
