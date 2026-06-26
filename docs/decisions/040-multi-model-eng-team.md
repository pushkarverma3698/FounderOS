# ADR-040: Multi-Model Engineering Team — Adopt, Phased

**Status:** Accepted (Phase 0) · 2026-06-25
**Builds on:** rule #1 (Ollama-first), rule #6/ADR-023 (generator≠critic), rule #17 (reuse-first), ADR-039 (release train)
**Research:** `docs/research/MULTI-MODEL-ENG-TEAM.md`

## Context

Most development runs in a single Opus 4.8 session, paying the premium tier for mechanical
work (edits, test runs, commit messages, dep parsing, log triage) a far cheaper model does
equally well. The founder's token budget is the binding constraint. Question: build a
Claude-managed multi-model engineering team to cut cost?

## Decision

**Adopt multi-model routing as a discipline over existing primitives — do NOT build a new
orchestration subsystem.** The capability already exists (Claude Code `Task`/`Agent` subagents
with per-agent `model` override, 205 specialist agent defs, mandatory Ollama routing). Route
each task to the cheapest sufficient tier:

- **Local Ollama ($0):** JSON/deps/commits/embeddings/dedupe (already mandatory, rule #1).
- **Haiku 4.5 (worker):** high-frequency mechanical edits, scaffolds, doc updates, single-file changes.
- **Sonnet 4.6 (engineer):** main implementation + most code review.
- **Opus 4.8 (architect):** design, cross-file reasoning, debugging, security/final review, orchestration.

Orchestrator→worker→reviewer pattern, with the reviewer in a **different model family** than
the generator (extends rule #6). Only synthesized results cross subagent boundaries (rule #20).

## Decision scope (this ADR)
- **Phase 0 accepted now:** enforce the existing tiering — Ollama for mechanical, explicit
  `model: haiku` for mechanical subagents. Zero new code.
- **Phase 1 (next):** run one real feature through the pattern on the weekly train; **measure**
  blended cost vs single-Opus baseline using the per-turn budget tracker.
- **Phase 2 (gated on measured savings):** codify routing in a thin playbook/skill + guardrails.
- **Deferred:** any standalone always-on multi-agent "team framework" — fails the feature
  triple-filter (rule #17) until savings are proven.

## Consequences
- **+** Mechanical tokens shift from Opus → Haiku/local at materially lower blended rate, with no new infra to maintain.
- **+** Reuses the agent roster + Ollama + subagent model override already in place.
- **−** Cheaper models follow complex instructions less reliably (rule #16): mitigated by narrow worker tasks, strong-tier judgment/routing, and verifying every worker output (rule #24).
- **−** Cold-subagent context re-derivation has overhead: only spawn when the task dwarfs its setup; don't spawn for trivial work.
- **Risk if ignored:** unquantified savings claims. Mitigation: no hard % is claimed until Phase 1 measures it.
