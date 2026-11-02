# Architecture Decision Records — Index

51 ADRs spanning three rewrites (v1 → v2 → v3, see [ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md)).
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

Update 2026-10-27: the Status column below is copied from each ADR's own `Status:` line, so it
cannot disagree with the file. "Archived" means the code the ADR describes was deleted (kernel,
departments, gateway layers); the text stays as a record, and the tag `archive/founderos-v3`
holds the code. FounderOS now runs only the jobs pipeline (`src/jobs/main.ts`). The methodology
paragraph above describes how the 2026-07 statuses were first assigned; it no longer sets them.

Numbering collisions (three ADRs share `028`, two share `029` — an artifact of parallel work,
never renamed to avoid breaking existing inbound links) are disambiguated below by letter.

| # | File | Decision | Status |
|---|---|---|---|
| 001 | [why-langgraph](001-why-langgraph.md) | Why LangGraph instead of a custom state machine | Archived |
| 002 | [why-drizzle](002-why-drizzle.md) | Why drizzle-orm instead of Prisma | Accepted |
| 003 | [critic-pattern](003-critic-pattern.md) | The critic pattern — cross-model quality gate | Archived |
| 004 | [why-telegram-hitl](004-why-telegram-hitl.md) | Why Telegram for HITL approvals | Accepted |
| 005 | [why-redis-for-caching](005-why-redis-for-caching.md) | Why Redis for caching instead of Postgres tables | Accepted |
| 006 | [auth-strategy](006-auth-strategy.md) | Auth strategy — Composio internal + Google OAuth SaaS | Archived |
| 007 | [gateway-agnostic-architecture](007-gateway-agnostic-architecture.md) | Gateway-agnostic architecture | Archived |
| 008 | [ship-website-builder-gumroad-defer-linkedin](008-ship-website-builder-gumroad-defer-linkedin.md) | Ship website-builder + Gumroad; defer LinkedIn | Archived |
| 009 | [linkedin-automation-ban-risk](009-linkedin-automation-ban-risk.md) | Defer LinkedIn automation until ban-risk research | Deferred |
| 010 | [v2-react-agent-rebuild](010-v2-react-agent-rebuild.md) | Rebuild as prebuilt supervisor + ReAct sub-agents | Archived |
| 011 | [portfolio-as-product-and-eval-harness](011-portfolio-as-product-and-eval-harness.md) | Portfolio-as-product + eval harness over a critic | Archived |
| 012 | [personal-department](012-personal-department.md) | Personal department (laptop operator), HITL + path-guard | Archived |
| 013 | [keep-personal-and-engineering-separate](013-keep-personal-and-engineering-separate.md) | Keep `personal` and `engineering` scoped separately | Archived |
| 014 | [job-first-public-ready](014-job-first-public-ready.md) | Job-first sequencing + public-ready now | Archived |
| 015 | [personal-rag-read-only-boundary](015-personal-rag-read-only-boundary.md) | `personal-rag` read-only from every agent tool | Accepted |
| 016 | [memory-single-source-of-truth](016-memory-single-source-of-truth.md) | Memory: FounderOS as the single source of truth | Accepted |
| 017 | [bounded-conversation-history](017-bounded-conversation-history.md) | Bounded conversation history (an early loop fix) | Archived |
| 018 | [job-application-confirmed-submit-only](018-job-application-confirmed-submit-only.md) | Founder clicks, machine confirms before recording | Accepted |
| 019 | [engine-swap-claude-code-executor](019-engine-swap-claude-code-executor.md) | Engine swap — Claude Code as the task executor | Archived |
| 020 | [kill-switch-and-prod-hardening-scope](020-kill-switch-and-prod-hardening-scope.md) | Global kill switch + pre-production hardening scope | Archived |
| 021 | [multi-agent-transition-and-token-measurement](021-multi-agent-transition-and-token-measurement.md) | Production multi-agent transition, phase 1 | Archived |
| 022 | [typed-interdept-contracts](022-typed-interdept-contracts.md) | Typed inter-department contracts, phase 2 | Archived |
| 023 | [claude-as-judge](023-claude-as-judge.md) | Claude-as-judge for outbound copy, phase 3 | Archived |
| 024 | [dept-signals-over-postgres](024-dept-signals-over-postgres.md) | Durable cross-department signals over Postgres, phase 4 | Archived |
| 025 | [hierarchy-proof-on-prebuilts](025-hierarchy-proof-on-prebuilts.md) | Hierarchy proof on the prebuilt supervisor, phase 5 | Archived |
| 026 | [weekly-qa-auditor](026-weekly-qa-auditor.md) | Weekly QA auditor — deterministic funnel, Claude-judged | Archived |
| 027 | [tool-count-and-handoff-rules](027-tool-count-and-handoff-rules.md) | Tool-count and handoff rules for the hierarchical company | Archived |
| 028a | [composio-vs-direct-clis](028-composio-vs-direct-clis.md) | Composio vs. direct CLIs (gws, gh, LinkedIn API) | Superseded |
| 028b | [langchain-v1-model-agnostic](028-langchain-v1-model-agnostic.md) | LangChain v1, model-agnostic office | Archived |
| 028c | [manager-no-tools-hierarchy](028-manager-no-tools-hierarchy.md) | Manager has no tools (CrewAI hierarchical rule) | Archived |
| 029a | [direct-platform-integrations](029-direct-platform-integrations.md) | Direct platform integrations (provider abstraction) | Accepted |
| 029b | [p2-engineering-subgraph-wired](029-p2-engineering-subgraph-wired.md) | P2: engineering subgraph wired into live office | Archived |
| 030 | [p3-engineering-handoff-slice](030-p3-engineering-handoff-slice.md) | P3: engineering handoff typed state slice | Archived |
| 031 | [p4-p5-p6-hierarchy-phases](031-p4-p5-p6-hierarchy-phases.md) | P4/P5/P6: signal transactions, schema split, hierarchy tracing | Archived |
| 032 | [deterministic-anti-hallucination-guards](032-deterministic-anti-hallucination-guards.md) | Deterministic, model-agnostic anti-hallucination guards | Archived |
| 033 | [ai-native-studio-repositioning](033-ai-native-studio-repositioning.md) | AI-native studio repositioning | Accepted |
| 034a | [proof-drop-pipeline](034-proof-drop-pipeline.md) | Proof Drop pipeline (phase D-Bis GTM) | Archived |
| 034b | [recurring-hallucination-audit](034-recurring-hallucination-audit.md) | Why hallucination bugs recur — full audit | Archived |
| 035a | [daily-budget-guard](035-daily-budget-guard.md) | Daily budget guard (universal cost control) | Archived |
| 035b | [website-builder-e2e-pipeline](035-website-builder-e2e-pipeline.md) | Website builder E2E pipeline | Archived |
| 036 | [account-registry](036-account-registry.md) | Integration account registry | Accepted |
| 037 | [apify-research-engine](037-apify-research-engine.md) | Apify as the research department's real-data engine | Accepted |
| 038 | [postgres-canonical-brain](038-postgres-canonical-brain.md) | Postgres is the canonical brain | Accepted |
| 039 | [weekly-release-train](039-weekly-release-train.md) | Weekly release train + enforced quality gates | Superseded |
| 040 | [multi-model-eng-team](040-multi-model-eng-team.md) | Multi-model engineering team, adopt phased | Accepted |
| 041 | [mcp-client-bridge](041-mcp-client-bridge.md) | External MCP client bridge | Accepted |
| 042 | [multi-business-parameterization](042-multi-business-parameterization.md) | Multi-business parameterization, bounded not SaaS | Archived |
| 043 | [checkpoint-ttl-and-idempotency-window](043-checkpoint-ttl-and-idempotency-window.md) | Checkpoint TTL sweep + opt-in idempotency window | Archived |
| 044 | [creative-department-and-roadmap-p1-p4](044-creative-department-and-roadmap-p1-p4.md) | Creative department + roadmap P1–P4 | Archived |
| 045 | [retire-stable-tier](045-retire-stable-tier.md) | Retire the `stable` tier — two-stage promotion | Superseded |
| 046 | [operating-model-freeze](046-operating-model-freeze.md) | The engineering operating model is frozen | Accepted |

There is no ADR for the v3 rebuild itself — that decision is the subject of the whole repo.
Start with [JARVIS-ARCHITECTURE.md](../../JARVIS-ARCHITECTURE.md) and
[ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md) instead.
