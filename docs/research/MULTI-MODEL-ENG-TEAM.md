# Research: A Claude-Managed Multi-Model Engineering Team

**Date:** 2026-06-25 · **Type:** decision research · **Deliverable:** recommendation only (no build)
**Question:** Should we stand up a Claude-managed engineering team of *different* models —
routing task types to cheaper models — to cut token cost on feature delivery?

> Grounded in: the existing `~/.claude/agents/` roster (205 agents), the mandatory Ollama
> local-routing in CLAUDE.md, the Anthropic model lineup (Opus 4.8 / Sonnet 4.6 / Haiku 4.5),
> and this repo's locked 7-department architecture. Live model pricing should be confirmed
> against the Anthropic console before committing budget figures.

## TL;DR — Recommendation: **GO, but phased and lightweight (adopt, don't build).**

Do **not** build a new orchestration subsystem. The capability already exists: Claude Code's
`Task` tool spawns subagents with a **per-agent model override**, there are 205 specialist
agent definitions, and Ollama local routing is already mandatory. A "multi-model engineering
team" is therefore a **routing discipline layered on existing primitives**, not new infra
(rule #17). Expected saving: a large fraction of mechanical/worker tokens move off Opus to
Haiku/Sonnet/local at materially lower cost, while judgment work stays on Opus.

## The cost problem

Today most work runs in a single Opus 4.8 session — the most capable and most expensive
tier — including mechanical work (file edits, test runs, commit messages, dependency parsing,
log triage) that a far cheaper model does equally well. We pay Opus rates for Haiku-grade
tasks. The founder's token budget is the binding constraint (CLAUDE.md preamble).

## The model tiers (map task → cheapest sufficient model)

| Tier | Model | Cost posture | Best for |
|---|---|---|---|
| **Local** | Ollama qwen2.5 / nomic-embed | **$0** | JSON extraction, dep parsing, commit messages, embeddings, dedupe (already mandatory) |
| **Worker** | Haiku 4.5 | ~3× cheaper than Sonnet, ~90% of its coding ability | high-frequency edits, scaffolding, test scaffolds, single-file changes, doc updates, mechanical refactors |
| **Engineer** | Sonnet 4.6 | mid | main feature implementation, code review, most coding tasks |
| **Architect** | Opus 4.8 | premium | architecture, cross-file reasoning, debugging tangled interactions, security judgment, final review, orchestration |

This mirrors the guidance already in `~/.claude/rules/ecc/common/performance.md` — the tiering
isn't new policy, it just isn't *enforced* in practice.

## The orchestration pattern (reuse, not new code)

```
            Orchestrator (Opus/Sonnet) — plans, decomposes, holds context
                 │ Task(subagent_type=…, model=…)
   ┌─────────────┼─────────────────────────────┐
   ▼             ▼                              ▼
 Worker        Worker            Reviewer (different family)
 Haiku         Haiku             Sonnet/Opus  ← generator ≠ critic (rule #6)
 edits/tests   scaffolds         code-reviewer / security-reviewer
   │             │                              │
   └──── mechanical sub-steps → Ollama local ($0) ──────┘
```

- **Orchestrator** keeps the plan + context; spawns workers with explicit `model:` overrides.
- **Workers** (Haiku) do bounded, well-specified tasks and return only results (matches the
  context-isolation rule #20 — only synthesized output crosses the boundary).
- **Reviewer** is a *different model family/tier* than the generator — the existing
  generator≠critic discipline (rule #6, ADR-023) extends naturally to code review.
- **Local** absorbs all deterministic mechanical work at $0 (rule #1).

No new runtime: this is the `Agent`/`Task` tool + the agent roster + `subagent_type` +
`model` parameter, used deliberately.

## Mapping onto what exists
- `planner` / `architect` → Opus (orchestrator + design).
- `backend-developer` / `typescript-pro` / `fullstack-developer` → Sonnet (implementation).
- `build-error-resolver` / `refactor-cleaner` / `doc-updater` → Haiku (mechanical).
- `code-reviewer` / `security-reviewer` / `typescript-reviewer` → Sonnet/Opus (critic tier).
- Ollama MCP → all JSON/dep/commit/embedding tasks ($0).

The repo's own 7-department architecture stays **untouched and locked** — this is about how
*we build FounderOS*, not about FounderOS's runtime agents.

## Reliability trade-offs (the honest risks)
1. **Cross-model determinism (rule #16).** Cheaper models follow complex instructions less
   reliably. Mitigation: give workers *narrow, well-specified* tasks; keep judgment and routing
   on the strong tier; verify every worker output (rule #24) rather than trusting it.
2. **Context re-derivation cost.** Each cold subagent re-reads context — spawning has overhead.
   Net saving only holds when the worker task is big enough to dwarf its setup. Don't spawn for
   trivial one-liners (the existing "don't over-spawn" guidance applies).
3. **Review quality.** A Haiku reviewer can miss subtle bugs. Keep CRITICAL/security review on
   Opus/Sonnet; Haiku may do first-pass lint-level review only.
4. **Coordination complexity.** More moving parts = more failure surface. Start with 1
   orchestrator + 1–2 workers, not a 10-agent swarm.

## Expected savings (confirm against live pricing)
Mechanical work is a large share of tokens in a typical feature session. Moving it from Opus to
Haiku (~3× cheaper) + local ($0), while keeping ~the judgment fraction on Opus, yields a
substantial blended-rate reduction on build sessions. The exact percentage depends on the
mechanical/judgment split per feature and current per-token pricing — instrument it (below)
before quoting a hard number. **Do not claim a specific % until measured** (rule #24).

## Recommendation & phased adoption
**GO — phased, measured, reuse-first.**

- **Phase 0 (now, $0):** Enforce the *existing* tiering — always route JSON/deps/commits/
  embeddings to Ollama; explicitly pass `model: haiku` when spawning mechanical subagents.
  Pure discipline, no new code.
- **Phase 1:** Adopt the orchestrator→worker→reviewer pattern for one real feature on the new
  weekly train (ADR-039). Instrument tokens/cost per tier (reuse the per-turn budget tracker
  from rule #20). Compare blended cost vs a single-Opus baseline on the same feature.
- **Phase 2 (only if Phase 1 shows real, measured savings):** Write a thin orchestration
  playbook / skill that codifies the routing so it's repeatable, plus guardrails (verify every
  worker output, critic ≠ generator family). Still no heavy infra.
- **DEFER** any standalone multi-agent "team framework" / always-on swarm — it fails the
  feature triple-filter (rule #17) until Phase 1 proves the savings are real.

See ADR-040.
