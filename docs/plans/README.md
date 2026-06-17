# FounderOS Plans Index

All strategic and implementation plans for FounderOS development.

## Active Plans

### Strategy (current — 2026-06-17)

- **[../strategy/README.md](../strategy/README.md)** — **The Autonomous Studio** — master strategy index
- **[2026-06-17-LATEST-SESSION-PLAN.md](2026-06-17-LATEST-SESSION-PLAN.md)** — Session plan that produced the strategy doc set
- **[../phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md](../phases/PHASE-D-BIS-PROOF-AND-DISTRIBUTION.md)** — Active phase (supersedes PHASE-D-REVENUE-FLYWHEEL)

### Phase Plans (engineering — still valid)

- **[2026-06-14-MULTI-AGENT-TRANSITION-v2.md](2026-06-14-MULTI-AGENT-TRANSITION-v2.md)** — Production-grade multi-agent orchestration (v2)
  - Phases 1-6 SHIPPED (context isolation, typed contracts, Claude-as-judge, dept_signals, hierarchy proof, CLAUDE rules)
  - Phase 7 specialist hardening (pending merge of P1-6)
  - Key decision: flat system first, nesting proof-gated, token leverage via Gemini implicit caching

- **[2026-06-14-HIERARCHY-AND-REVENUE-PLAN.md](2026-06-14-HIERARCHY-AND-REVENUE-PLAN.md)** — Hierarchical company architecture (engineering; GTM superseded by strategy/)
  - 7 phases P0-P6 for evolving flat 7-dept supervisor → hierarchical CTO-led company
  - Revenue domain: Marketing → Sales → Support chain
  - ~70% architectural work already in codebase (dept_signals, contracts, nested-HITL proven)

- **[2026-06-16-PRODUCTION-HARDENING-PLAN.md](2026-06-16-PRODUCTION-HARDENING-PLAN.md)** — Production stabilization hardening
  - Senior tech-debt audit + reliability fixes
  - G1-G12 findings (OpenRouter failover, atomic PG locking, context isolation guards, HITL cleanup)
  - Backlog + severity classification in docs/LIMITATIONS.md

### Session Plans

- **[2026-06-17-LATEST-SESSION-PLAN.md](2026-06-17-LATEST-SESSION-PLAN.md)** — Current session objectives and deliverables

## Historical Plans

Additional plans are stored in `~/.claude/plans/` (46 total). Key completed plans:
- Initial FounderOS architecture (May 2026)
- Composio + executor auth (June 2026)
- Weekly QA auditor rebuild (June 2026)
- Turn-tracing observability (June 2026)
- Recursive HITL hardening (June 2026)

## Plan Sync

All plans are synchronized to **turicks-brain** knowledge base via `pnpm brain:sync` for vector-based retrieval and context preservation across sessions.

Last sync: 2026-06-17
