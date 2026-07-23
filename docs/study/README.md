# FounderOS Study Materials

> Learning resources and the build log for FounderOS.
> The old v2 learning path (multi-agent supervisor, 7 ReAct departments, Phases 1–6 hardening) was retired with the v2 architecture on 2026-07-08. To understand the **current v3 kernel**, read the architecture docs; to understand **how we got here**, read the case studies.

---

## Understand the current architecture (v3)

The v2 study sequence described an architecture that no longer exists. The authoritative, up-to-date material now lives at the root and in the docs index:

1. **[../../CLAUDE.md](../../CLAUDE.md)** — the contract-first kernel, one orchestration path, anti-slop CI invariants
2. **[../../JARVIS-ARCHITECTURE.md](../../JARVIS-ARCHITECTURE.md)** — why v2 failed within 3 steps; the typed StateGraph that replaced it
3. **[../../ZERO-BASE-AUDIT.md](../../ZERO-BASE-AUDIT.md)** — 4 live failure traces that justified the rebuild
4. **[../PROOF.md](../PROOF.md)** — the executable guarantees (each is a scenario, not a claim)
5. **[../README.md](../README.md)** — the full documentation index

---

## The story: v1 → v2 → v3

**[../turicks-case-studies/](../turicks-case-studies/)** — candid engineering case studies on where we fell for AI slop, over-engineered, and simplified for production. Written for the Turicks community and website.

---

## Build log & postmortems (kept)

- **[CASE-STUDY-LOG.md](CASE-STUDY-LOG.md)** — append-only build-in-public record: milestones, decisions, metrics. Newest first.
- **[POSTMORTEM-eval-outputMode.md](POSTMORTEM-eval-outputMode.md)** — a real bug postmortem: why `outputMode: "last_message"` hid ToolMessages, and `handleToolStart` as the correct eval-observation pattern. (Historical — from the v2 eval harness — but the lesson generalizes.)

---

## 👉 Then read the code

1. [../../src/kernel/contracts.ts](../../src/kernel/contracts.ts) — the contracts *are* the architecture (`TaskEnvelope`, `Plan`, `StepResult`, `FailureReport`, `ToolReceipt`)
2. [../../src/kernel/graph.ts](../../src/kernel/graph.ts) — the one orchestration path as a StateGraph
3. [../../src/gateway/kernel-boot.ts](../../src/gateway/kernel-boot.ts) — the only composition root
4. [../../tests/unit/kernel/kernel-e2e.test.ts](../../tests/unit/kernel/kernel-e2e.test.ts) — the full graph running offline at $0

To build or extend: follow [../rules/PROGRAMMING-RULES.md](../rules/PROGRAMMING-RULES.md).
