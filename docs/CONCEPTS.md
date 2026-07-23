# FounderOS — Concepts & Glossary

The domain vocabulary, in one place. If a term in the code or docs is unclear,
it's defined here. Ordered roughly from "big idea" to "detail."

### Kernel
The deterministic orchestration core (`src/kernel/`). A **pure library**: it
receives models, tools, and a checkpointer by injection and never reads env or
builds a provider client. This is what lets the full graph run offline in CI at
$0. Contrast with the **gateway**, which handles transport and policy.

### Gateway
The transport + policy layer (`src/gateway/`). `telegram.ts` is the grammY bot;
`kernel-run.ts` is the run loop (lock → gates → invoke → HITL card / reply);
`kernel-boot.ts` is the **only composition root** where providers are wired.

### Contract-first
The design principle that every boundary between components is a Zod-validated
type *before* any code is written to cross it. "The contracts are the
architecture" — see [`src/kernel/contracts.ts`](../src/kernel/contracts.ts).

### Plan
A typed, ordered list of steps (`≤ MAX_PLAN_STEPS = 8`) produced once by the
planner LLM. Has a `goal` and `steps[]` with unique ids.

### PlannerDecision
The planner's output: a discriminated union of either `{type: "reply"}` (a direct
answer, one LLM call) or `{type: "plan"}` (a typed `Plan`).

### TaskEnvelope
**The only thing a worker sees.** A validated object carrying one step's
`objective`, `inputs`, `expected` output contract, `dependencies`, and
`constraints` (`max_tool_calls`, `hitl_required`). Replaces v2's empty-argument
`transfer_to_x({})` handoff.

### Worker (department)
An isolated agent that executes one step with envelope-only context and a capped
tool set. There are 8: `admin`, `research`, `comms`, `engineering`, `marketing`,
`sales`, `personal`, `jobhunt`. ("Department" is the older, interchangeable word.)

### Supervisor / dispatch
**Pure code**, not an LLM. Takes `plan[cursor]`, produces a `TaskEnvelope`, and
advances the cursor. Deterministic and unit-tested.

### StepResult
A discriminated union: `{status: "ok", output, tool_receipts}` or
`{status: "failed", failure}`. The supervisor branches on `status`, never on prose.

### ToolReceipt
Code-recorded proof that a tool ran: `tool`, `args_hash`, `result_digest`, `ok`,
`at`, `idempotency_key`. Written by the tool adapter, **never by the model** — the
basis of the zero-hallucination guarantee.

### Output contract (`schema_ref`)
A named Zod schema an envelope's output must satisfy: `text.summary`,
`research.findings`, `draft.email`, `draft.linkedin_post`, `action.summary`,
`data.generic`, or a `signal.*`. Checked by `validateStepResult`.

### `action_receipt` (expected kind)
An envelope whose `expected.kind` is `action_receipt` performs a real side effect.
Its result is rejected unless it carries a successful `ToolReceipt`. This is the
**zero-hallucination** mechanism.

### FailureReport
A typed failure: `stage` (validation/planning/routing/tool/model/budget/timeout/
hitl_rejected), `component`, `message`, `evidence`, `retryable`. The founder always
sees it. Replaces v2's swallowed errors and thread-wiping "recovery."

### HITL (Human-in-the-Loop)
The approval mechanism. A gated tool calls LangGraph's `interrupt()`; the graph
pauses (state checkpointed to Postgres); the gateway renders an Approve/Reject
card; the side effect runs only after an approved resume. 17 tools are gated.

### Idempotency key
A deterministic, tenant-scoped, content-addressed key (`sha1` of the action
parts), checked against `action_log` before the side effect so a retry can't
double-send. (Distinct from a `ToolReceipt`'s `args_hash`, which is a `sha256`.)

### Checkpointer
LangGraph's Postgres saver (`PostgresSaver`) that persists per-thread graph state,
making HITL crash-safe and enabling cross-turn memory. Its tables are separate
from the app tables.

### Mission
The per-turn execution record: `goal`, `status`
(`planning → executing → awaiting_approval → synthesizing → done` / `failed`),
`plan`, and `cursor`.

### Signal
A typed, durable message one worker publishes for another (`dept_signals` table),
validated by `SIGNAL_CONTRACTS`. Asynchronous, peripheral to the main path.

### Tombstone
A killed module (`pre-router`, `execution-guard`, `office.ts`, `office-run`,
domain subgraphs) that **fails CI if recreated** — so v2's slop can't grow back.

### Ratchet
The architecture-debt baseline (`governance/architecture-baseline.json`) that CI
allows to shrink but never grow. Keeps `regex-routing`, `gateway-imports`,
`kernel-purity` at 0.

### AI slop
Plausible, confident, over-engineered AI-generated code that passes review and
fails production. The failure mode the [case studies](turicks-case-studies/)
document escaping.

### turicks-brain / personal-rag
Two **separate** knowledge stores (`brain` schema). Business knowledge vs
founder-private career data — never cross-written (ADR-013/015).

### Video Factory
A standalone client social-video engine (`video-factory/`, outside the pnpm
workspace); the kernel-side tools are pure and $0.
