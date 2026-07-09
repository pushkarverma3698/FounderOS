# FounderOS — Jarvis-Grade Orchestration Layer: Contract-First Architecture

**Role:** Chief Systems Architect · **Date:** 2026-07-07
**Status:** DESIGN — no new code written; awaiting founder approval of the StateGraph below (per directive)
**Companion evidence:** `ZERO-BASE-AUDIT.md` (4 live execution traces; all claims below cite them or fresh source verification)

---

## 1. Why the current system fails within 3 steps of a complex task

Entry point: `src/index.ts` → `gateway/telegram.ts` → `gateway/office-run.ts:runOfficeText()` → `agents/office.ts` (createSupervisor). Traced live in the Zero-Base Audit. The failure is not one bug — it is three independent decay mechanisms, one per step:

**Step 1 — Intake: the task is mutated before any agent sees it.**
A complex task hits `pre-router.ts` first. Nine keyword regexes claim it on *first match* in a fixed order (`personal → marketing → engineering → …`), so "research competitors and then email the summary to Sam" matches `RESEARCH_RE` (`\bresearch\b`) and gets force-routed to ONE department with an injected `[ROUTING DIRECTIVE … CRITICAL …]`. Multi-step awareness exists only in `task-ledger.ts`, which recognizes **exactly two hardcoded task shapes** (a "Monday brief" regex and a "research then github" regex). Every other complex task enters the graph as a single-department directive that contradicts its own content. There is no plan object anywhere — the "plan" is a prose plea injected into the prompt: *"execute steps IN ORDER … relay each department's output verbatim."* Nothing tracks whether steps actually ran.

**Step 2 — Handoff: the task's data does not survive the boundary.**
The supervisor delegates via `transfer_to_<dept>({})` — an **empty-argument tool call**. The department receives no task object; it re-infers the task from the shared message history. That history is trimmed to a 4,000-token rolling window before every call (`context-manager.ts`), and the one mechanism that would pin the original request through trimming (`preserveTaskAnchor`, context-manager.ts:207) **defaults to false and is never enabled on the main path** (verified: `office.ts` `agentMiddleware` never sets it). The return trip is worse: `outputMode: "last_message"` hands back a single prose string, so structured data produced in step 1 (emails, URLs, scores, lists) must survive a prose round-trip to be usable in step 2. By the second handoff a complex task is playing telephone with itself.

**Step 3 — Verification: the system attacks its own output.**
After the graph returns, `execution-guard.ts` (~77 regexes) judges whether the model "really" did the work. Three terminal outcomes, all observed or traced:
- *False positive* → the gateway **re-invokes the entire graph** (2× cost) and may then replace a correct answer with a canned refusal while purging messages from the Postgres checkpoint (`purgeFabricatedAiFromCheckpoint`).
- *Model loops* → the tool-call cap silently removes the tool from the schema (audit Run D: the model keeps calling it for 10 more hops) → `GraphRecursionError` → `clearThreadAfterAbort()` **wipes the thread's checkpoints**. The complex task and all its completed steps are erased as "recovery."
- *Provider fails* → `model.ts:is503Error()` classifies errors by 15 substrings; anything outside them (401/403/404) skips the fallback chain and dumps a raw error.

Three steps, three uncoordinated failure modes, and no layer that can say *which step of the task* died or *resume* from it. That is the architectural absence this document fixes.

---

## 2. Phase 1 — Silent-failure points (untyped boundaries)

Every place data crosses between agents without a strict, typed schema:

| # | Boundary | Current carrier | Failure mode |
|---|---|---|---|
| 1 | supervisor → department | `transfer_to_X({})` + shared trimmed history | task re-inferred; goal can be trimmed away mid-run |
| 2 | department → supervisor | one prose string (`last_message`) | structured data lossy-decoded from prose |
| 3 | gateway → graph | regex-injected `SystemMessage` directives | prompt and directive can contradict; untestable |
| 4 | COS → engineering CTO | typed object **serialized into prose** with a marker string (`handoff-engineering.ts`), regex-parsed back out | a schema smuggled through an untyped channel |
| 5 | tool → agent | stringified result; failure detected by keyword scan (`/fail\|error\|blocked/`) | success mentioning "error" flagged; structured failures missed |
| 6 | graph → checkpoint | gateway **rewrites history** post-hoc (purge functions) | the durable record is not append-only; next turn sees edited past |
| 7 | multi-step plan → execution | prose "TASK LEDGER" SystemMessage | no step state, no completion check, no resume point |
| 8 | error → fallback | substring taxonomy in `is503Error` | unlisted error classes bypass recovery silently |

Plus ~20 `.catch(() => null)` / warn-and-continue sites in `office-run.ts` + `index.ts` (state reads, purges, budget checks — all fail-open), a fail-open LLM judge, and a live-loop test tier that `describe.skip`s itself without API keys.

## 3. Phase 1 — Over-engineering: 5 modules flagged for deletion

Complexity without reliability (LOC measured; full rationale in audit §4–§7):

1. **`src/gateway/execution-guard.ts`** (591 LOC, ~77 regexes) — post-hoc lie detection driving double invokes and checkpoint rewrites. Replaced by typed `StepResult` validation: a worker that didn't call the tool cannot produce a valid `action_receipt`.
2. **`src/gateway/pre-router.ts` regex rules** (267 LOC) — Router #1 of 3. Replaced by the planner node; keep only the explicit `[route directly to X]` developer override.
3. **`src/gateway/task-ledger.ts`** (81 LOC) — two hardcoded regex "plans" as prose. Replaced by the real, schema-validated `Plan`.
4. **Fast-path trio** — `inbox-fast-path.ts`, `github-read-fast-path.ts`, `shell-hitl-fast-path.ts` (225 LOC) — hand-coded parallel agents that exist only because routing was unreliable. A deterministic supervisor makes them redundant.
5. **Flag-gated alternate topologies** — `engineering-domain.ts`, `revenue-domain.ts`, `creative-department.ts` (+4 test files) — three parallel org charts compiled into production code, all off by default. Per your rule — a path we can't guarantee stable gets deleted, not flagged.

---

## 4. Phase 2 — Contract-First Architecture

### 4.1 The global `SystemState`

One typed state object replaces "the message list is everything." Zod-validated at every node boundary; a mismatch is a **terminal, reported failure**, never a retry-and-hope.

```typescript
/** THE graph state. Single source of truth for one run. schema_version bumps on shape change. */
interface SystemState {
  schema_version: 1;

  /** Immutable intake record — set once by validate_input, never trimmed, never rewritten. */
  turn: {
    id: string;              // trace id (joins telemetry + action_log)
    chat_id: string;
    received_at: string;     // ISO
    raw_input: string;
  };

  /** The mission — the anchor the current system loses. */
  mission: {
    goal: string;                                   // normalized task statement
    status: "planning" | "executing" | "awaiting_approval" | "synthesizing" | "done" | "failed";
    plan: TaskStep[];                               // produced ONCE by the planner, schema-validated
    cursor: number;                                 // index of the active step
  };

  /** Typed outputs of completed steps — the ONLY inter-agent data bus. */
  results: StepResult[];

  /** Fail-fast: set once, terminal. NO silent retries, NO guessed data. */
  failure: FailureReport | null;

  /** HITL ledger — every approval/rejection with its step id (DB row written BEFORE interrupt()). */
  approvals: ApprovalRecord[];
}

/** What a worker receives. ONLY this — workers never see conversation history. */
const TaskEnvelope = z.object({
  step_id: z.string(),
  worker: z.enum(WORKERS),                          // closed set
  objective: z.string().min(8),                     // planner must state the task explicitly
  inputs: z.record(z.unknown()),                    // named refs into prior StepResult outputs
  expected: z.object({
    kind: z.enum(["data", "draft", "action_receipt"]),
    schema_ref: z.string(),                         // key into OUTPUT_CONTRACTS registry
  }),
  constraints: z.object({
    max_tool_calls: z.number().int().min(1).max(6), // cap hit = typed failure, NOT silent schema removal
    hitl_required: z.boolean(),
  }),
});

/** What a worker returns. Discriminated — the supervisor branches on `status`, never on prose. */
const StepResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    step_id: z.string(),
    output: z.unknown(),                            // MUST validate against expected.schema_ref
    tool_receipts: z.array(ToolReceipt),            // proof of execution — replaces regex lie detection
  }),
  z.object({ status: z.literal("failed"), step_id: z.string(), failure: FailureReport }),
]);

/** Rule #22 as a type: errors name the REAL failing component, staged. */
const FailureReport = z.object({
  step_id: z.string(),
  stage: z.enum(["validation", "planning", "routing", "tool", "model", "budget", "timeout", "hitl_rejected"]),
  component: z.string(),                            // "postgres/pgvector", "openrouter", "github_write"…
  message: z.string(),                              // human-readable, surfaced verbatim to founder
  evidence: z.string().optional(),                  // raw error snippet / HTTP status
  retryable: z.boolean(),                           // supervisor MAY retry retryable steps ONCE, visibly
});
```

`contracts.ts` survives intact: its `dept_signals` schemas become entries in the same `OUTPUT_CONTRACTS` registry, and `validateSignalPayload`'s total-function pattern is the template for every boundary validator.

### 4.2 Supervisor-Worker topology — the decisive change

**The supervisor is deterministic code, not an LLM.** It manages `SystemState` and delegates; it performs no work — including no *inference* work. LLM calls exist in exactly three places: the **planner** (goal → `Plan`), the **workers** (execute one envelope), and the **synthesizer** (results → reply). This is what makes the system deterministic: routing is data produced once and validated, not a per-hop model decision that three regex layers then second-guess.

- Workers are ReAct subgraphs with **isolated context**: system prompt + `TaskEnvelope`. No shared history, no other departments' chatter — rule #20 by construction rather than by `outputMode` pinning.
- A worker ends in exactly two ways: a schema-valid `StepResult.ok`, or `StepResult.failed` with a `FailureReport`. Tool-cap exhaustion, model errors, and validation misses all produce the *failed* branch — fail-fast, named, resumable.
- Ambiguous requirements are a **schema fix, not a code fix**: if the planner cannot fill a required envelope field (e.g. `send_email` needs `to:` and the input has none), planning fails with `stage: "validation"` and the founder is asked for the missing field. The system never guesses data.

### 4.3 State checkpointing

The Postgres checkpointer (`PostgresSaver`) is already the strongest component — it stays. Two contract changes:
1. **Append-only.** Every node transition is checkpointed; nothing ever edits or purges history (`purge*FromCheckpoint` and `clearThreadAfterAbort`-as-recovery are deleted). Failure states are checkpointed too — so `mission.cursor` makes any run **resumable from its exact failed step**, including across process crashes and HITL pauses.
2. **Loop abort ≠ data loss.** A recursion/timeout abort checkpoints `failure` and ends the run with a report naming the step; the thread and completed steps survive.

### 4.4 The StateGraph

```mermaid
flowchart TD
    IN([Telegram / Web message]) --> V[validate_input\npure Zod, no LLM]
    V -- invalid --> RPT
    V --> P[planner\nLLM call #1: goal → Plan]
    P -- "Plan fails Zod /\nmissing required field" --> RPT
    P --> S{supervisor\nPURE CODE — no LLM\nowns SystemState:\nread plan[cursor] → dispatch}

    S -- "TaskEnvelope\n(typed, validated)" --> W[worker subgraph\nLLM: isolated context =\nsystem prompt + envelope ONLY\ntools capped by constraints]
    W -- "action tool &\nhitl_required" --> H[HITL interrupt\nDB row → interrupt\npauses on checkpoint]
    H -- approved --> W
    H -- rejected --> S
    W -- "StepResult.ok\n(output validates against\nexpected.schema_ref)" --> S
    W -- "StepResult.failed\n(FailureReport)" --> S

    S -- "failure &&\n!retryable" --> RPT[report\ntyped FailureReport → founder:\nstage + component + evidence\nstate checkpointed, resumable]
    S -- "failure &&\nretryable (ONCE, visible)" --> W
    S -- "cursor < plan.length" --> S
    S -- "all steps done" --> Y[synthesizer\nLLM: results[] → reply\nno tools]
    Y --> OUT([reply + audit row])
    RPT --> OUT

    CP[(Postgres checkpointer\nAPPEND-ONLY\nevery transition persisted\nresume from any node)]
    V -.-> CP
    P -.-> CP
    S -.-> CP
    W -.-> CP
    H -.-> CP
    Y -.-> CP
```

Properties, contrasted with today:

| Property | Today | This design |
|---|---|---|
| Routing decisions per task | 3 layers × N hops | 1 (planner), validated once |
| Task identity mid-run | trimmed prose history | `mission.goal` + `cursor`, immutable |
| Inter-agent data | prose round-trips | `results[]`, schema-validated |
| Model loop outcome | 14 hops → thread wiped | cap → typed failure at that step, resumable |
| "Did it really run the tool?" | 77 regexes | `tool_receipts` in the contract |
| Supervisor token cost | 11.5 KB prompt × every hop | 0 (it's code) |
| Verifiability offline | impossible (model not injectable) | planner/workers take injected models; supervisor is pure functions |

---

## 5. Phase 3 — Kill Order (context-bloat edition)

Ranked by tokens/complexity reclaimed. Tiers 2–3 of the Zero-Base Audit kill order still apply; this ranks what bloats *context* specifically:

1. **The LLM supervisor loop itself** — 11.5 KB prompt + 8 transfer-tool schemas re-uploaded on every routing hop (measured: 52.6 KB for a one-line task). Becomes pure code: the single largest token line-item goes to zero.
2. **Injected prose directives** — `[ROUTING DIRECTIVE…]`, `CRITICAL — SHELL RUN`, `[TASK LEDGER…]`, the engineering handoff marker-envelope. All become fields in `TaskEnvelope`.
3. **Shared message history as the data bus** — workers today receive the whole (trimmed) conversation; under envelopes they receive ~200–800 bytes.
4. **Execution-guard double invokes** — the single most expensive control-flow branch (full second graph run) — deleted with the module.
5. **`execution-guard.ts`, `pre-router.ts` rules, `task-ledger.ts`, fast-path trio, flagged subgraphs** — §3 list, ~1,400 LOC of control-flow regexes whose *maintenance* context (every future session re-reading them) is itself the bloat.
6. **`apps/jarvis`, `apps/jarvis-next`, `client/`, cockpit/mission-control/stream-hub gateway modules** — a second product living inside the bot's blast radius.
7. **~70 of 109 scripts + 80→12 npm scripts** — five generations of gate pipelines nobody can hold in working memory.

## 6. Migration in verifiable slices (post-approval)

Each slice lands green (`pnpm lint && pnpm test`) with the loop **testable offline** — models injectable, supervisor pure — closing the audit's core gap. Order: (1) contracts + `SystemState` + registry tests → (2) deterministic supervisor + planner behind a flag, evaled against golden tasks → (3) workers on envelopes, HITL re-wired (DB-before-interrupt preserved) → (4) delete Tier-1 kill list + the guard machinery → (5) gateway slim-down, kill Tiers 2–3.

**Stop point honored:** no new code has been written. The diagram above is the approval gate.
