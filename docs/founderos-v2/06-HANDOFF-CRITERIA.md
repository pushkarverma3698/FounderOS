# 06 — Handoff Criteria: when bootstrapping stops

> **Claude and Antigravity are contractors hired to build the factory. Once the factory runs, the
> factory produces its own improvements.**

The stopping condition is **not** "implement the 33 days." It is:

> **Implement until FounderOS can execute the next milestone itself.**

Those are different targets, and optimizing the first produces a system nobody ever hands over.

---

## The Doctrine

> **If FounderOS is capable of doing a task, humans are no longer allowed to do it manually.**

Not "should prefer not to" — **not allowed**. The rule exists because the founder re-becoming the
bottleneck is the default outcome, not an edge case.

| Week | Human does | Later | FounderOS does |
|---|---|---|---|
| 1 | Creates missions | 5 | Creates missions — **founder stops** |
| 2 | Reviews implementation plans | 6 | Generates them — founder only approves |
| 3 | Writes architecture summaries | 8 | Writes them — **founder stops** |

---

## M-C · Capability Transfer (standing gate, every milestone)

Every milestone closes with this loop before it may be called done:

```
Human performs task
      ↓
FounderOS documents the task
      ↓
FounderOS automates the task
      ↓
Human forbidden from repeating it manually
```

This is a **per-milestone exit criterion**, not a milestone at the end — its whole purpose is
continuous absorption of the founder's workflow, so deferring it to the end defeats it.

### Capability Transfer Ledger

| Task | Performed by | Documented | Automated | Human stopped | Milestone |
|---|---|---|---|---|---|
| Dead-code / orphan audit of the source tree | Claude (by hand, 2026-08-06) | ✅ `01-CODE-AUDIT.md` | ✅ `src/evolution/analyzers/dead-code.ts` | **✅ yes — never audit dead code by hand again** | M0a |
| Founder-time measurement | Founder (manual log) | ✅ `M0.5-FOUNDER-TIME-LOG.md` | ⬜ pending `/time` decision | ⬜ | M0.5 |
| Writing Antigravity implementation briefs | Claude | ✅ `docs/antigravity/README.md` | ⬜ | ⬜ | M6 |
| Mission creation | Founder | ⬜ | ⬜ | ⬜ | M0b |
| Ranking what to build next | Founder + Claude | ✅ `03-BACKLOG-GRAPH.md` | ⬜ | ⬜ | M1 |
| Choosing which worker does a task | Claude (hardcoded `WORKERS`) | ⬜ | ⬜ | ⬜ | M3 |
| Reviewing implementation diffs | Founder | ⬜ | ⬜ | ⬜ | M-R |

**Every future milestone adds its rows here before it may be closed.**

---

## Phase 0 — Bootstrap (now)

Humans + Claude + Antigravity build the minimum viable Executive Intelligence System.
Goal: **get FounderOS capable of improving itself.** Not: build the roadmap.

### Bootstrap boundary — what must work before Claude stops driving

| # | Capability | Milestone | Status |
|---|---|---|---|
| 1 | Evolution Engine v0 (self-audit sensor) | M0a | 🟡 **in progress** — dead-code analyzers green, acceptance gate passing |
| 2 | Mission persistence | M0b | ⬜ |
| 3 | Outcome tracking + business-KPI linkage | M0b | ⬜ |
| 4 | Review pipeline | M-R | ⬜ |
| 5 | Executive Engine | M1 | ⬜ |
| 6 | **Intelligence Engine** | M2 | ⬜ |
| 7 | Worker/Capability Registry | M3 | ⬜ |
| 8 | **Single tool boundary** | M4 | ⬜ |
| 9 | Reflection pipeline | M5 | ⬜ |

**Two additions to the founder's list, with reasons:**

- **M2 (Intelligence Engine)** is a hard prerequisite for M3. A Worker Registry that cannot rank
  providers by measured success, cost and latency is just a lookup table — dispatch would fall back
  to hardcoded assumptions, which is what M3 exists to remove.
- **M4 (single tool boundary)** is a *safety* prerequisite for autonomous dispatch. Today 20 files
  call `hitlGate` directly and the tested adapter has zero production importers. Letting FounderOS
  dispatch its own work through 20 uncoordinated side-effect paths is the failure mode with no
  recovery path.

Everything else — Knowledge Graph, Capability Marketplace, Signal bus, Business Workflows, Founder
Memory, Market Awareness, Metrics, Plugins, Parallel execution, Amputation — becomes a **FounderOS
mission**, not a Claude task.

---

## The handoff test

Bootstrapping ends the first time FounderOS completes all six steps **unprompted**:

1. Produces a ranked improvement proposal **from telemetry**, not from a human asking
2. Creates a durable mission record for it, with cost, priority, risk class and business linkage
3. Generates an implementation brief **self-contained enough for Antigravity to execute**
4. Dispatches it
5. Collects the result and runs the verify command
6. Records an outcome with a **measured before/after delta**

**If a human had to supply any one of those six, the handoff has not happened.** No partial credit —
step 3 is where most systems quietly fail, and step 6 is where they fail expensively.

Claude will evaluate this test at the end of each working session and report the result plainly,
including which step is the current blocker.

---

## Phase 1 — Assisted Evolution

FounderOS proposes work. It can create missions, generate implementation plans, dispatch
Antigravity, request Claude reviews, collect telemetry, and measure outcomes.

**The founder still approves high-risk work** — per the M-R risk classes, and the standing rail that
missions touching `verify-architecture.ts`, HITL sets, or CI config are always founder-merge.

Claude's role shrinks to: architecture decisions, high-risk review, and unblocking.

## Phase 2 — Autonomous Improvement

FounderOS owns its own backlog. Instead of the founder saying *"build M5"*, FounderOS says:

> *"Based on the last 47 missions, review latency is now the bottleneck. I propose M7.3 to improve
> reviewer throughput."*

That is the moment the system earns its name. Everything after it is governed by the frozen rule:
changes originate from **measured telemetry**, **a concrete founder pain point**, or **a business
KPI that is not improving** — never from another speculative redesign.

---

## Operating loop until handoff

1. **Claude** writes a detailed implementation brief for the next dependency-ready milestone
   → `docs/antigravity/`
2. **Antigravity** implements it
3. **Claude** reviews the diff and re-runs verify — never accepting Antigravity's summary
4. **Founder** decides architecture and approves high-risk work only
5. Repeat until the handoff test passes

**Session close:** Claude stabilizes what was built, updates the Capability Transfer Ledger and the
bootstrap status table above, and states plainly whether the handoff test passes and which step
blocks it.
