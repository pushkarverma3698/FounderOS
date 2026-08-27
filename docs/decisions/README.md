# Architecture Decision Records — Index

50 ADRs spanning three rewrites (v1 → v2 → v3, see [ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md)).
Read chronologically they're confusing — most were written *about* the department/supervisor
architecture that was torn out on 2026-07-08. Read with the status column below, they're a
decision log: what was tried, what broke, what replaced it, and why.

**Methodology.** Status is derived from two objective signals, not re-litigated from scratch for
each file: (1) the file's first-commit date relative to the 2026-07-08 v3 rebuild
(`ZERO-BASE-AUDIT.md`), and (2) whether its subject matches a CI tombstone
(`office.ts`, `pre-router`, `execution-guard`, department/supervisor/hierarchy machinery —
`CLAUDE.md` "Anti-slop invariants") or a row in the README's own "Architecture Decisions" table.
Where neither signal settles it, the entry is marked **Historical context** rather than guessed
either way — an ADR whose conclusion was never re-confirmed against the current codebase.

## Start here — the 10 most interview-relevant

These are the decisions worth being able to talk through out loud; each names the alternative it
rejected and why, which is the part a "we used X" bullet point never shows.

| ADR | Decision | Why it's worth knowing |
|---|---|---|
| [046](046-operating-model-freeze.md) | The engineering operating model is frozen | Names the four allowed review outcomes — the actual answer to "how do you keep an AI agent from drifting the architecture" |
| [032](032-deterministic-anti-hallucination-guards.md) | Deterministic, model-agnostic anti-hallucination guards | Detection-vs-prevention, argued before it was proven — README's Challenge 2 is this decision paying off |
| [018](018-job-application-confirmed-submit-only.md) | Founder clicks, machine confirms — never the reverse | The HITL ordering principle applied to a real, high-stakes external action (a job application) |
| [015](015-personal-rag-read-only-boundary.md) | `personal-rag` is read-only from every agent tool | A concrete data-boundary rule, not a vague "least privilege" claim |
| [001](001-why-langgraph.md) | LangGraph over a custom state machine | Resumability + checkpoints + inspection, against the cost of vendor coupling — stated as a tradeoff, not a slogan |
| [017](017-bounded-conversation-history.md) | Bounded conversation history | An early, narrower attempt at the loop problem that README's SF-3 later shows was *not* the permanent fix — good evidence of honest iteration |
| [010](010-v2-react-agent-rebuild.md) | Rebuild as prebuilt-supervisor + ReAct sub-agents | **Superseded** — this is the decision that became the v2 system the zero-base audit tore out. Worth reading precisely because it was wrong, and for the right-sounding reasons at the time |
| [003](003-critic-pattern.md) | The critic pattern — cross-model quality gate | The origin of `governance/critique-rules.md`, still loaded by `criticNode` at runtime |
| [045](045-retire-stable-tier.md) | Retire the `stable` promotion tier | A rollback of an earlier decision, made in the open rather than quietly reverted |
| [042](042-multi-business-parameterization.md) | Multi-business parameterization, bounded not SaaS | Names the line between "generalize this" and "over-engineer this" with a business reason, not a technical one |

## Full log

Numbering collisions (three ADRs share `028`, two share `029` — an artifact of parallel work,
never renamed to avoid breaking existing inbound links) are disambiguated below by letter.

| # | File | Decision | Status |
|---|---|---|---|
| 001 | [why-langgraph](001-why-langgraph.md) | Why LangGraph instead of a custom state machine | Current |
| 002 | [why-drizzle](002-why-drizzle.md) | Why drizzle-orm instead of Prisma | Current |
| 003 | [critic-pattern](003-critic-pattern.md) | The critic pattern — cross-model quality gate | Historical context |
| 004 | [why-telegram-hitl](004-why-telegram-hitl.md) | Why Telegram for HITL approvals | Current |
| 005 | [why-redis-for-caching](005-why-redis-for-caching.md) | Why Redis for caching instead of Postgres tables | Current |
| 006 | [auth-strategy](006-auth-strategy.md) | Auth strategy — Composio internal + Google OAuth SaaS | Current |
| 007 | [gateway-agnostic-architecture](007-gateway-agnostic-architecture.md) | Gateway-agnostic architecture | Historical context |
| 008 | [ship-website-builder-gumroad-defer-linkedin](008-ship-website-builder-gumroad-defer-linkedin.md) | Ship website-builder + Gumroad; defer LinkedIn | Historical context |
| 009 | [linkedin-automation-ban-risk](009-linkedin-automation-ban-risk.md) | Defer LinkedIn automation until ban-risk research | Historical context |
| 010 | [v2-react-agent-rebuild](010-v2-react-agent-rebuild.md) | Rebuild as prebuilt supervisor + ReAct sub-agents | **Superseded** (this became v2) |
| 011 | [portfolio-as-product-and-eval-harness](011-portfolio-as-product-and-eval-harness.md) | Portfolio-as-product + eval harness over a critic | Historical context |
| 012 | [personal-department](012-personal-department.md) | Personal department (laptop operator), HITL + path-guard | **Superseded** (department model) |
| 013 | [keep-personal-and-engineering-separate](013-keep-personal-and-engineering-separate.md) | Keep `personal` and `engineering` scoped separately | Current (boundary cited live in `docs/FOUNDER-PROFILE.md`) |
| 014 | [job-first-public-ready](014-job-first-public-ready.md) | Job-first sequencing + public-ready now | Historical context |
| 015 | [personal-rag-read-only-boundary](015-personal-rag-read-only-boundary.md) | `personal-rag` read-only from every agent tool | Current |
| 016 | [memory-single-source-of-truth](016-memory-single-source-of-truth.md) | Memory: FounderOS as the single source of truth | Current |
| 017 | [bounded-conversation-history](017-bounded-conversation-history.md) | Bounded conversation history (an early loop fix) | Historical context |
| 018 | [job-application-confirmed-submit-only](018-job-application-confirmed-submit-only.md) | Founder clicks, machine confirms before recording | Current |
| 019 | [engine-swap-claude-code-executor](019-engine-swap-claude-code-executor.md) | Engine swap — Claude Code as the task executor | Historical context |
| 020 | [kill-switch-and-prod-hardening-scope](020-kill-switch-and-prod-hardening-scope.md) | Global kill switch + pre-production hardening scope | Current |
| 021 | [multi-agent-transition-and-token-measurement](021-multi-agent-transition-and-token-measurement.md) | Production multi-agent transition, phase 1 | **Superseded** (department model) |
| 022 | [typed-interdept-contracts](022-typed-interdept-contracts.md) | Typed inter-department contracts, phase 2 | **Superseded** (department model) |
| 023 | [claude-as-judge](023-claude-as-judge.md) | Claude-as-judge for outbound copy, phase 3 | Current (still the reviewer model for outbound copy) |
| 024 | [dept-signals-over-postgres](024-dept-signals-over-postgres.md) | Durable cross-department signals over Postgres, phase 4 | **Superseded** (department model) |
| 025 | [hierarchy-proof-on-prebuilts](025-hierarchy-proof-on-prebuilts.md) | Hierarchy proof on the prebuilt supervisor, phase 5 | **Superseded** (department model) |
| 026 | [weekly-qa-auditor](026-weekly-qa-auditor.md) | Weekly QA auditor — deterministic funnel, Claude-judged | Historical context |
| 027 | [tool-count-and-handoff-rules](027-tool-count-and-handoff-rules.md) | Tool-count and handoff rules for the hierarchical company | **Superseded** (department model) |
| 028a | [composio-vs-direct-clis](028-composio-vs-direct-clis.md) | Composio vs. direct CLIs (gws, gh, LinkedIn API) | Current |
| 028b | [langchain-v1-model-agnostic](028-langchain-v1-model-agnostic.md) | LangChain v1, model-agnostic office | Historical context |
| 028c | [manager-no-tools-hierarchy](028-manager-no-tools-hierarchy.md) | Manager has no tools (CrewAI hierarchical rule) | **Superseded** (department model) |
| 029a | [direct-platform-integrations](029-direct-platform-integrations.md) | Direct platform integrations (provider abstraction) | Current |
| 029b | [p2-engineering-subgraph-wired](029-p2-engineering-subgraph-wired.md) | P2: engineering subgraph wired into live office | **Superseded** (`office.ts` is a CI tombstone) |
| 030 | [p3-engineering-handoff-slice](030-p3-engineering-handoff-slice.md) | P3: engineering handoff typed state slice | **Superseded** (department model) |
| 031 | [p4-p5-p6-hierarchy-phases](031-p4-p5-p6-hierarchy-phases.md) | P4/P5/P6: signal transactions, schema split, hierarchy tracing | **Superseded** (department model) |
| 032 | [deterministic-anti-hallucination-guards](032-deterministic-anti-hallucination-guards.md) | Deterministic, model-agnostic anti-hallucination guards | Current (the principle v3's receipts deepen) |
| 033 | [ai-native-studio-repositioning](033-ai-native-studio-repositioning.md) | AI-native studio repositioning | Current (business framing, still active per `docs/FOUNDER-PROFILE.md`) |
| 034a | [proof-drop-pipeline](034-proof-drop-pipeline.md) | Proof Drop pipeline (phase D-Bis GTM) | Historical context |
| 034b | [recurring-hallucination-audit](034-recurring-hallucination-audit.md) | Why hallucination bugs recur — full audit | Historical context |
| 035a | [daily-budget-guard](035-daily-budget-guard.md) | Daily budget guard (universal cost control) | Current |
| 035b | [website-builder-e2e-pipeline](035-website-builder-e2e-pipeline.md) | Website builder E2E pipeline | Historical context |
| 036 | [account-registry](036-account-registry.md) | Integration account registry | Current |
| 037 | [apify-research-engine](037-apify-research-engine.md) | Apify as the research department's real-data engine | Historical context (department framing; Apify usage may persist) |
| 039 | [weekly-release-train](039-weekly-release-train.md) | Weekly release train + enforced quality gates | Historical context |
| 040 | [multi-model-eng-team](040-multi-model-eng-team.md) | Multi-model engineering team, adopt phased | Historical context |
| 041 | [mcp-client-bridge](041-mcp-client-bridge.md) | External MCP client bridge | Current |
| 042 | [multi-business-parameterization](042-multi-business-parameterization.md) | Multi-business parameterization, bounded not SaaS | Current |
| 043 | [checkpoint-ttl-and-idempotency-window](043-checkpoint-ttl-and-idempotency-window.md) | Checkpoint TTL sweep + opt-in idempotency window | Current |
| 044 | [creative-department-and-roadmap-p1-p4](044-creative-department-and-roadmap-p1-p4.md) | Creative department + roadmap P1–P4 | **Superseded** (department model) |
| 045 | [retire-stable-tier](045-retire-stable-tier.md) | Retire the `stable` tier — two-stage promotion | Current |
| 046 | [operating-model-freeze](046-operating-model-freeze.md) | The engineering operating model is frozen | Current |

*(038 does not exist — a numbering gap, not a missing file.)*

There is no ADR for the v3 rebuild itself — that decision is the subject of the whole repo.
Start with [JARVIS-ARCHITECTURE.md](../../JARVIS-ARCHITECTURE.md) and
[ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md) instead.
