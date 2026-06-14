# ADR-022 — Typed inter-department contracts (Phase 2)

- **Date:** 2026-06-14
- **Status:** Accepted
- **Branch:** `feat/phase2-typed-contracts`
- **Follows:** [ADR-021](021-multi-agent-transition-and-token-measurement.md)

## Context

Phase 2 of the production multi-agent transition is "typed inter-department
contracts + scoped state channels." The plan's intent (CLAUDE rule #21): a
department handoff must carry a **typed object**, validated at the boundary —
never a raw message dump the next department has to re-parse from prose.

A grounding read of the codebase found the real handoff substrate already exists
and is durable: the `dept_signals` table (`from_dept`, `to_dept`, `event_type`,
`payload` jsonb), whose schema comment explicitly says the payload is *"schema
defined by event_type convention."* That convention was implicit and unenforced.

## Decision

**1. Ship the typed contract layer; defer the live `stateSchema` channel.**
`src/agents/contracts.ts` defines one Zod contract per cross-department
`event_type` (`lead_discovered`, `proposal_approved`, `demo_ready`) plus a
deterministic, total `validateSignalPayload(eventType, payload)` gate (no LLM
call, never throws). This is the *typed vocabulary* every later phase consumes.

The originally-planned `OfficeState = Annotation.Root` scoped state channel wired
into `createSupervisor({ stateSchema })` is **deferred to Phase 5**, where the
nested `revenue` supervisor is its first real reader. Rationale (rule #17 / YAGNI):

   - In the current flat topology the supervisor mediates **all** inter-dept
     communication via the `messages` channel; **no department reads a custom
     state channel today**. Adding a live channel now = speculative substrate
     with zero consumers — the exact thing self-critique #1 of the plan warned
     against ("the HARD substrate is built and PROVEN by Phase 5's exemplar").
   - The prebuilt supervisor constrains managed agents to
     `AnnotationRootT["State"]`; the ReAct departments are built on plain
     `MessagesAnnotation`. Threading a wider `OfficeState` through them risks
     type-variance friction and `any`-casts on the production run-loop for no
     present benefit. We wire it once, with its first reader, under the
     integration test that proves nested interrupt/resume (Phase 5's gate).

**2. The contract is keyed by `event_type`, matching `dept_signals`.** Phase 4's
`publish_signal` tool and scheduler consumer validate with `validateSignalPayload`
before writing/acting. Phase 5 reuses the same contracts for the marketing↔sales
handoff. One definition, two consumers — not duplicated per call site.

**3. Closed event set, enforced parity.** `SIGNAL_EVENT_TYPES` is a closed tuple;
`SIGNAL_CONTRACTS` uses `satisfies Record<SignalEventType, ...>` so the compiler
rejects an event without a contract, and a registry test asserts runtime parity.

## Consequences

- Phase 2 is a pure, tested type module (8 tests, RED→GREEN) — zero run-loop risk,
  999 tests green, tsc clean.
- The "least-context-by-default" token claim (rule #21) gets a concrete mechanism:
  only a contract's declared fields cross a department boundary.
- Live state-channel wiring is consciously deferred to its first consumer (Phase 5),
  documented here so the deferral is a decision, not an omission.
- Next: Phase 3 (Claude-as-judge via `postModelHook`, generator≠critic, rule #6).
