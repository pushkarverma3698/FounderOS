# FounderOS — Architecture (v3)

> **One line:** You send a task over Telegram; a planner turns it into a typed,
> validated plan; a pure-code supervisor runs each step through an isolated
> worker; every external action produces a receipt; and the reply is written only
> from validated results — with your approval before anything is sent or changed.

This is the plain-English companion to [`CLAUDE.md`](../CLAUDE.md) (the canonical
rules) and the [diagrams](diagrams/). If you read one architecture doc, read this.

---

## The shape in five words

**plan → dispatch → work → collect → synthesize.**

That's the entire control flow, assembled as a single LangGraph `StateGraph` in
[`src/kernel/graph.ts`](../src/kernel/graph.ts). There is exactly one path. The
things a naive agent stack accumulates — a pre-router, a post-hoc guard,
fast-path bypasses — are all *deliberately absent*, and CI fails the build if any
of them come back. See [diagram 02](diagrams/02-orchestration-path.md).

---

## Walkthrough: one message, end to end

Take **"Research what Linear ships, then draft a cold email to their founder."**

1. **Gateway (`src/gateway/kernel-run.ts`).** The grammY bot receives the message.
   The run loop takes a per-chat lock (one turn at a time), runs pre-flight gates
   (global halt? budget left?), and invokes the kernel with the chat's thread id.

2. **plan (LLM #1).** The planner returns a typed `PlannerDecision`. A greeting
   would come back as `{type: "reply"}` and cost exactly one LLM call. This task
   comes back as `{type: "plan"}` — an ordered, validated `Plan`:
   - step 1 → `research`, objective "find what Linear ships", `expected: research.findings`
   - step 2 → `sales`, objective "draft a cold email", `expected: draft.email`, `inputs: {findings: <step 1>}`

3. **dispatch (pure code).** The supervisor is not an LLM. It takes `plan[cursor]`
   and hands it to a worker as a `TaskEnvelope` — the *only* thing the worker sees.
   No regex claims the message; no directive is stapled on.

4. **agent ⇄ tools (LLM #2).** The `research` worker runs with envelope-only
   context and a capped tool set. It calls `search_web`; the tool adapter executes
   it and records a code-authored `ToolReceipt`. The worker returns a `StepResult`.

5. **collect (pure).** `validateStepResult()` parses the output against
   `research.findings`. If it doesn't match, that's a typed failure — not a
   downstream agent quietly guessing. It matches; `cursor++`.

6. **dispatch → agent again.** Step 2 runs in the `sales` worker, receiving the
   validated step-1 findings as typed input (not a prose round-trip). It drafts the
   email. `send_email` is HITL-gated, so the graph **pauses at `interrupt()`** and
   the gateway renders an approval card.

7. **You approve.** The side effect runs *after* the approved resume: an
   idempotency key is checked, the email is sent, an `action_log` row is written
   with that key, and a receipt with `ok: true` is recorded.

8. **synthesize (LLM #3).** The final call writes the founder-facing reply from
   **validated results only**. It can say "✅ Email sent" only because a successful
   receipt exists. The reply ships with a receipts block.

Full data-type view: [diagram 04](diagrams/04-contract-dataflow.md).

---

## The five ideas that make it work

### 1. The contracts *are* the architecture
Every boundary is a Zod-validated type in
[`src/kernel/contracts.ts`](../src/kernel/contracts.ts): `TaskEnvelope`, `Plan`,
`StepResult`, `ToolReceipt`, `FailureReport`. A mismatch is a terminal, typed
failure — never a retry-and-hope. The task is a *data structure*, not a sentence
in a prompt.

### 2. The supervisor is pure code
Routing, cursor advancement, and step dispatch are deterministic functions with
unit tests — never prompt instructions. CI runs the golden set twice and requires
byte-identical plans. Temperature is 0 everywhere.

### 3. Workers are isolated
A worker sees only its `TaskEnvelope` — never the chat history, never other steps.
This is least-context: it makes each step testable in isolation and immune to
unrelated junk in the conversation. Tool sets are capped per worker (least
privilege — the `personal` worker's shell/file/browser access is walled off from
the business workers).

### 4. Actions require receipts (zero-hallucination)
An action step whose `expected.kind` is `action_receipt` is rejected unless it
carries a successful, code-recorded `ToolReceipt`. The synthesizer only ever sees
validated results, so it *cannot* narrate an action that didn't happen. See
[diagram 07](diagrams/07-receipt-and-zero-hallucination.md).

### 5. The kernel is a library
Models, tools, and the checkpointer are injected;
[`src/gateway/kernel-boot.ts`](../src/gateway/kernel-boot.ts) is the only
composition root. The kernel never reads env or builds a provider client — which
is what lets the full graph run offline in CI at **$0**.

---

## Safety, in order (never reordered)

FounderOS takes real actions, so ordering is a correctness property, not a nicety:

1. **HITL row before `interrupt()`** — the approval is durable before the graph
   pauses, so a crash mid-approval resumes cleanly (`src/infra/hitl.ts`).
2. **Side effects only after an `approved` resume** — a reject, crash, or stale
   card is always a clean no-op.
3. **Idempotency key checked before every external send** — a retry can never
   double-send.
4. **`action_log` row only on real success** — a 200 with an error body is not
   success; we check for the provider's id.

See [diagram 03](diagrams/03-hitl-flow.md) and the [HITL matrix](guides/HITL-MATRIX.md).

---

## How failure is handled

Failure is a typed value, not an exception to swallow. A `FailureReport` names
`stage + component + evidence + retryable`, and the founder always sees it. A
runaway worker loop terminates at the step cap (`MAX_TOOL_CALLS_PER_STEP = 6`) as
a typed failure — the thread is **never** silently wiped. Only `/reset` wipes a
thread, by explicit founder command. Fail-open `catch` blocks are taxed: each one
needs an `// allow-failopen: <reason>` tag and is counted by the CI debt ratchet.

---

## Keeping it simple (forever)

Six CI rules in [`scripts/verify-architecture.ts`](../scripts/verify-architecture.ts)
make good architecture the only shape the build allows: **tombstones** (killed
modules can't return), **regex-routing = 0**, **gateway-imports = 0**,
**kernel-purity = 0**, a **400-line file budget**, and the **fail-open tax**. The
debt baseline may only shrink. See [diagram 08](diagrams/08-anti-slop-ci-gates.md)
and the [case studies](turicks-case-studies/) for why every one of these exists.

---

## Where things live

| Layer | Path | Role |
|-------|------|------|
| Kernel | `src/kernel/` | contracts, planner, supervisor (pure), worker, synthesizer, graph, tool-adapter |
| Composition | `src/gateway/kernel-boot.ts` | the only place providers are wired |
| Run loop | `src/gateway/kernel-run.ts` | lock → gates → invoke → HITL card / reply |
| Transport | `src/gateway/telegram.ts` | grammY bot + commands |
| Tools | `src/tools/`, `src/agents/agent-tools/` | UnifiedTool implementations |
| Capabilities | `src/agents/capabilities.ts` | worker → tools (single source of truth) |
| Infra | `src/infra/` | hitl, checkpointer, budget, health |
| Data | `src/db/` | schema (`agents` + `brain`) + queries |
| External surface | `src/mcp/` | read-only MCP server |

Next: [FEATURES.md](FEATURES.md) — what it can do, feature by feature.
