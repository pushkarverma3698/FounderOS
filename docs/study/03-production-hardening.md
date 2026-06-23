# Production Hardening — Phases 1–6

*How FounderOS went from a working prototype to a production-grade multi-agent system.
Each phase is an ADR + code. Read this alongside the ADRs in `docs/decisions/021–025`.*

---

## Why This Exists

On 2026-06-14, an external advisor handed over a "prototype → production SaaS" checklist
(ephemeral containers, BullMQ, distributed tracing, hierarchical supervisors). A file-grounded
audit revealed FounderOS already shipped ~70% of it. What was genuinely missing became a
6-phase hardening program.

**The north star for every phase:** make the guarantee structural — something that a type
checker, a boot-time assertion, or a unit test enforces — rather than relying on a developer
remembering to do the right thing.

---

## Phase 1 — Context Isolation + Token Measurement (ADR-021)

### The Problem

In `createSupervisor`, `outputMode` controls how much a sub-agent's internal work is
visible to its parent. The two modes are:

| Mode | What crosses the boundary |
|------|--------------------------|
| `"last_message"` | Only the sub-agent's final response text |
| `"full_history"` | Every intermediate tool call + result |

The library default is `"last_message"` — which is correct: a department's internal tool
calls (reading emails, running web searches) are noise the supervisor doesn't need. But
"the library default" is one config typo away from becoming `"full_history"` and leaking
internal department state into the supervisor's history.

### The Fix: Structural Assertion

`src/agents/context-isolation.ts` converts a silent default into a loud boot-time assertion:

```typescript
export const CONTEXT_ISOLATION_OUTPUT_MODE = "last_message" as const;

export function assertContextIsolation(mode: string): ContextIsolationMode {
  if (mode !== CONTEXT_ISOLATION_OUTPUT_MODE) {
    throw new Error(`Context isolation violation (rule #20): got "${mode}". ` +
      `"full_history" leaks tool calls into supervisor history.`);
  }
  return CONTEXT_ISOLATION_OUTPUT_MODE;
}
```

In `office.ts`:
```typescript
createSupervisor({
  agents: coreAgents,
  outputMode: assertContextIsolation(CONTEXT_ISOLATION_OUTPUT_MODE), // ← loud if wrong
  ...
})
```

**Why it matters for LangGraph:** `outputMode` is a `createSupervisor`-level option that
controls the `MessagesAnnotation` reducer on the parent graph. When set to `"full_history"`,
every `ToolMessage` from inside a sub-agent appends to the parent graph's `messages[]` —
growing the supervisor's context window with implementation details that are irrelevant to
routing decisions and cost tokens on every subsequent turn.

### Token Measurement

Phase 1 also added per-turn token logging on the `turn.out` seam (greppable by `turnId`):

```
inputTokens / outputTokens / usd logged per turn
```

**Gemini implicit caching insight:** Gemini 2.5 Flash auto-caches shared prefixes ≥ 1024
tokens (≤75% cost reduction). The supervisor system prompt is ~2.8k tokens. By keeping the
prefix byte-stable (no per-turn volatile injection ahead of it), caching kicks in
automatically — a free cost lever with zero infrastructure.

**Why no Redis caching?** Redis would add infrastructure for a near-zero cache hit rate in
interactive temp-0 use. The real Gemini implicit caching is server-side and free. Redis is
deferred to Phase E (multi-instance rate limiting), not adopted as a caching layer.

---

## Phase 2 — Typed Inter-Department Contracts (ADR-022)

### The Problem

The `dept_signals` table had always existed (`from_dept`, `to_dept`, `event_type`,
`payload jsonb`) but `payload` was untyped. A research department could publish a signal
with any shape, and the sales department would receive it with no guarantee about what
fields existed.

This is the "raw message dump" anti-pattern: department B re-parses department A's prose
instead of receiving a typed object.

### The Fix: `src/agents/contracts.ts`

One Zod schema per `event_type`. A closed union ensures every event has a contract:

```typescript
export const SIGNAL_EVENT_TYPES = [
  "lead_discovered",
  "proposal_approved",
  "demo_ready",
  "design_brief_ready",
  "site_deployed",
  "proof_drop_ready",
] as const;

// LeadDiscoveredPayload = Zod schema with: company, contactName, contactEmail,
//                          icpScore (0-100), source, notes
```

The `validateSignalPayload` function is deterministic and total — it never throws:

```typescript
export function validateSignalPayload(
  eventType: SignalEventType,
  payload: unknown,
): ValidationResult {
  const schema = SIGNAL_CONTRACTS[eventType];
  const result = schema.safeParse(payload);
  return result.success
    ? { valid: true, data: result.data }
    : { valid: false, error: result.error.message };
}
```

**The compiler-enforced parity rule:** `SIGNAL_CONTRACTS satisfies Record<SignalEventType, ZodSchema>` — add an event type without its contract → compile error.

### Why the `stateSchema` Channel Was Deferred

The original plan included wiring a typed `OfficeState` into `createSupervisor({ stateSchema })`.
This was deferred (YAGNI, rule #17): in the current flat topology, the supervisor mediates
all inter-department communication via `messages[]` — no department reads a custom state
channel today. Adding a live channel for zero consumers is speculative substrate. It will
be wired in Phase 5 when the nested `revenue` supervisor becomes its first real reader.

---

## Phase 3 — Claude-as-Judge for Outbound Copy (ADR-023)

### The Problem

CLAUDE rule #6 ("Generator: Gemini · Critic: Claude") existed only as a written rule. In
code, the same Gemini model drafted and self-checked outbound copy. Sycophancy: a model
cannot objectively critique its own output.

### The Fix: `src/infra/judge.ts`

Gate 1 (deterministic, brand-validator) already existed. Phase 3 adds Gate 2:

```
Draft → [Gate 1: brand-validator] → [Gate 2: Claude judge] → [Gate 3: HITL]
```

Key design decisions:

**1. Tool seam, not `postModelHook`.**
The draft exists as structured text inside `send_email` / `linkedin_post` — exactly where
Gate 1 (brand-validator) already lives. `postModelHook` fires after every model step
(including intermediate tool-planning), not just outbound drafts. The tool seam is
outbound-only by construction.

**2. Fail-open always.**
```typescript
export function isJudgeEnabled(): boolean {
  return !!process.env["ANTHROPIC_API_KEY"];
}
```
No key → no-op pass. Model error → pass. Unparseable output → pass. HITL is the final
gate; the judge may only add a critique to the approval card — it cannot silently block.

**3. Memoized per `(channel, text)`.** The HITL `interrupt()` re-executes the tool body on
resume. Without memoization, that's a second Claude API call for the same draft. TTL cache
makes the second execution a cache hit.

**4. Deterministic verdict parsing.** The verdict is parsed by a pure, unit-tested function:
```typescript
export function parseJudgeVerdict(raw: string): JudgeVerdict {
  try {
    const obj = JSON.parse(raw.trim());
    if (obj.verdict === "pass") return { verdict: "pass" };
    if (obj.verdict === "revise" && typeof obj.critique === "string") {
      return { verdict: "revise", critique: obj.critique };
    }
  } catch { /* fall through */ }
  return { verdict: "pass" }; // fail-open on malformed
}
```

**Activation status:** Gate 2 is active only when `ANTHROPIC_API_KEY` is configured.
In dev (no Anthropic key), the judge is a no-op pass. To enable in production, set
`ANTHROPIC_API_KEY` (and optionally `JUDGE_MODEL`, defaults to `claude-haiku-4-5`).

---

## Phase 4 — Durable Cross-Department Signals (ADR-024)

### The Problem

One department discovers a lead. A different department needs to act on it — later, without
holding open a single LangGraph run. The advisor doc proposed BullMQ/Redis for this. For a
single-operator system that's over-engineering.

### The Fix: Postgres `dept_signals` Table

The table existed. Phase 4 wires two tools that use it:

**Publisher (research / marketing / engineering call this):**
```typescript
// publish_signal tool — not HITL-gated (internal coordination, no external side effect)
const result = await publishDeptEvent({
  fromDept: "research",
  toDept: "sales",
  eventType: "lead_discovered",
  payload: validateSignalPayload("lead_discovered", { company, contactName, ... }),
});
// → row in dept_signals with UUID
```

**Consumer (hourly scheduler sweep):**
```typescript
// consumePendingEvents — atomic exactly-once (marks consumed before acting)
const signals = await consumePendingEvents("sales");
// signals has: lead_discovered, proposal_approved, etc.
// Cron sends a Telegram nudge to the founder — NEVER auto-invokes the office
```

**Why no auto-invoke?** A headless cron context can't host the gateway's interrupt/resume
loop. Faking it would bypass HITL (rule #4). The signal surfaces work; it never performs it.

**Exactly-once semantics:** The consumer atomically marks a signal `consumed=true` before
processing. Even if the cron runs twice, the second run gets zero signals.

---

## Phase 5 — Hierarchy Proof on Prebuilt Supervisor (ADR-025)

### The Problem

The advisor doc's headline item was hierarchical supervisors. But "can we draw a tree?" was
the wrong question. The real question: **does HITL `interrupt()` raised deep inside a nested
supervisor surface and resume through the gateway's `getState().tasks` path?**

### The Spike: `src/agents/revenue-domain.ts`

Rather than touching the live office (which would risk the fragile run loop), Phase 5 builds
a separate spike:

```
parent-supervisor
  ├─ research (flat)
  └─ revenue (nested sub-supervisor)
        ├─ marketing → linkedin_post (HITL-gated)
        └─ sales → send_email (HITL-gated)
```

The integration test `tests/integration/nested-hitl.test.ts` proves:
1. `linkedin_post` interrupt **surfaces** via `getPendingApproval()` — 3 levels deep
2. **Reject** → LinkedIn tool is NEVER called
3. **Approve** → runs exactly once
4. Research question routes parent → research with **no** interrupt (control)

**Why this works on prebuilts (no `StateGraph` rewrite):**
`createSupervisor` with nested sub-supervisors-as-agents uses the same `getState().tasks`
path as flat agents. The `interrupt()` exception bubbles through the compiled graph
hierarchy; the parent checkpointer saves it all. The prebuilt abstractions handle it.

### Production Promotion Gate (Double-Gated)

Nesting is NOT in production yet. It requires:
1. A real **trigger** — a domain with ≥2 genuinely coordinating agents (YAGNI)
2. **Live MTProto verification** of nested interrupt/resume on the real Telegram gateway

Until both hold, the flat 8-department topology is correct. Depth is capped at 2 if/when
promoted (ADR-027: max 2 levels avoids latency/debugging cost of deeper nesting).

**The engineering subgraph** (`src/agents/engineering-domain.ts`) follows the same pattern:
three sub-agents (coder / qa / devops) under a CTO sub-supervisor, activated via
`ENGINEERING_SUBGRAPH_ENABLED=1`. Both are off by default in production.

---

## Phase 6 — CLAUDE Rules #20–21 Operationalized (ADR-021/022 close-out)

Phase 6 was the integration of rules #20 (context isolation) and #21 (typed handoffs)
into a security guide (`docs/guides/SECURITY-RULES-20-21.md`) and a verification protocol.

**Rule #20 verification checklist:**
- `assertContextIsolation()` call exists in every `createSupervisor`
- Structural test (`tests/unit/context-isolation.test.ts`) forbids `"full_history"` under `src/agents/`
- Per-turn `inputTokens`/`outputTokens` logged + measurable against baseline

**Rule #21 verification checklist:**
- `validateSignalPayload` called before every `dept_signals` write
- Registry test asserts parity: every `SIGNAL_EVENT_TYPES` entry has a `SIGNAL_CONTRACTS` entry
- No raw prose handoff in any cross-department tool call

---

## Lessons for LangGraph Engineers

1. **Pin your outputMode explicitly.** The library default is correct, but defaults are
   invisible. An `assertContextIsolation()` wrapper makes the guarantee auditable.

2. **Typed contracts before live channels.** ADR-022 shipped the Zod contracts (pure module,
   zero run-loop risk) before wiring the `stateSchema` channel. The contract vocabulary is
   reused by Phases 4 and 5 without rework.

3. **Fail-open critics.** A judge that can block production is more dangerous than no judge.
   Gate 2 (Claude) can only add a critique; Gate 3 (HITL) is the real decision point.

4. **Postgres for durable, Gemini caching for cheap.** Two decisions that sound like
   infrastructure choices are actually "pick the right layer": durable state in Postgres
   (queryable, transactional), ephemeral caching via Gemini implicit caching (free,
   server-side, zero infra).

5. **Prove hierarchy before promoting it.** A nested-HITL integration test on an additive
   spike (no live code touched) gave portfolio-grade evidence with zero production risk.

---

*See next: [05-safety-and-quality-gates.md](./05-safety-and-quality-gates.md) — all safety
mechanisms in one place: anti-hallucination guards, tool failure envelope, idempotency,
suppression, budget.*
