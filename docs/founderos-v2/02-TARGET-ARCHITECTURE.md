# 02 — Target Architecture: Venture Operating System

## Identity

**FounderOS is an Executive Intelligence System.**
Operationally and falsifiably: *a system that converts founder intent into executed, measured
outcomes across a portfolio of ventures.*

**FounderOS is not the product. It is the internal operating system. The product is everything it
builds.**

```
FounderOS ──► builds businesses ──► businesses generate value
     ▲                                        │
     └──────── businesses improve FounderOS ◄─┘
```

**First KPI: not "how autonomous?" but "how much founder work disappeared?"**
Saving 20 hrs/week at 40% autonomy beats 90% autonomy that saves none. Measured by
[M0.5-FOUNDER-TIME-LOG.md](M0.5-FOUNDER-TIME-LOG.md).

## The Constitution

> **1. Every manual action must become a future capability.** Automatable? Reusable? Measurable?
>
> **2. Every capability must generate knowledge.** Assets · playbooks · benchmarks · patterns ·
> DNA · **policy**. Automation without compounding is just faster burning.

**Enforced:** a mission terminating without at least one asset row fails its own acceptance check.

## Layering

```
Portfolio          ← allocation policy on the Executive Engine (NOT an engine — N<3 ventures)
  └─ Business      ← COMPANY_PROFILES: turicks, naggar — BUILT, zero importers
      └─ Product
          └─ PROBLEM          ← first durable entity; holds the business KPI
              └─ Workflow (days–months) | Mission (hours–days)
                  └─ Task Graph
                      └─ Capability          ← first class; stable across model generations
                          └─ Execution Strategy   ← single · dual-review · consensus ·
                              │                      tournament · human-approval
                              └─ Providers        ← claude · gemini · antigravity ·
                                  │                  ollama · human · future
                                  └─ Tools / MCP plugins
```

### Problems, not missions, start the system

Companies don't begin with missions — they begin with problems ("revenue dropping", "churn").
A problem may exist with no mission yet; several missions may attack one problem; **the problem
holds the KPI**. Implementation: one table, one FK. Not a hierarchy.

### Capability → Strategy → Provider

The inversion that ages best. **Capabilities are stable; providers rotate every few months;
execution policy is independent of both.** A new model release is a provider row, not a refactor.

```
Capability := { id, domain, description,
                strategies[]: { kind, providers[]: { provider_id, success (Wilson-bounded),
                                                     N, cost, latency, available } } }
```

Claude, Gemini, Antigravity, Ollama **and a human** register identically. `rank.ts` is pure code —
**no LLM in the scheduler**, the same doctrine that made `dispatch()` correct.

### Uncertainty is a field set, not an engine

Every decision record carries `evidence · confidence · unknowns · assumptions · missing_data`.
Bare confidence produces expensive high-confidence hallucinations. Same instinct as the Wilson
bounds required in M2, generalised.

### Resources are a vector

`claude_budget · gemini_budget · gpu · cpu · vps · storage · money ·` **`founder_time ·
founder_attention`**

Founder attention is the scarcest resource in the system. That is why review throughput (M-R) sits
on the critical path rather than being an afterthought.

### The 80/20 rule, as a mechanism

> Missions with `business_id = founderos` may not exceed **20% of mission spend and time in any
> rolling 30-day window.** Past the cap, Evolution Engine proposals are **queued, not dispatched.**

Enforced by the Executive Engine; measurable because M0b attributes `ai_call_costs` to `mission_id`.
This is the invariant that prevents an infinitely self-improving system that ships no business value.

### Memory lifecycle

```
observation → memory → generalization → principle → POLICY → automation
```

Policy is where knowledge becomes enforcement — **and the enforcement half already exists**:
`scripts/verify-architecture.ts` fitness functions with the ratchet are policy-as-code running in CI
today. A learned principle ("every payment integration needs replay protection") becomes a fitness
rule. **What is missing is derivation, not enforcement.**
Also required: decay for stale memories, merge for duplicates.

### Plugins

"Can this be a plugin?" is a **design question at every node** — using the plugin boundary that
already exists: `applyMcpBridge()` runs in `kernel-boot.ts` before worker specs read
`DEPARTMENT_TOOLS`, and `mergeBridgedTools` merges external MCP tools *including their HITL gate
names* (ADR-041, `src/mcp/bridge-manifest.ts`).

**Not done before crossover:** a refactor extracting existing subsystems into plugins. That churns
the kernel and the plugins simultaneously while both are still moving.

## Deferred until data exists (not cancelled)

**Simulation Engine · Prediction Engine · Portfolio Engine.** All three require historical
observations that do not yet exist. Building sophisticated planning layers before there are enough
observations to validate them is the exact error that sensors-before-evolution prevents.
Revisit at ≥1 quarter of outcome data.

## Explicitly dropped

| Dropped | Reason |
|---|---|
| Dynamic per-mission LLM teams (CEO→Architect→Backend→Reviewer) | This repo built department subgraphs, audited them, killed them. They are **CI tombstones** — recreation fails the build. The Capability Registry supersedes them and is strictly stronger. |
| 7-critic review boards | 7 LLM calls per merge replacing deterministic gates that already work at $0. Keep `pnpm gate`; at most one critic. |
| 6 always-on daemons | One Hetzner box already runs bot + Postgres + Ollama; latency is an existing incident class. Cadence ladder on the existing scheduler instead. |
| "Delete the central retry loop" | The escalating retry + typed `FailureReport` **is** the anti-hallucination mechanism. |
