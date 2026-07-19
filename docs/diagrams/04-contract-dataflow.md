# 04 — Contract Data Flow (the task as a typed object)

In v2 the task was a sentence smuggled through a prompt and a trimmed history.
In v3 the task is a **typed object at every boundary**, defined in
[`src/kernel/contracts.ts`](../../src/kernel/contracts.ts) and Zod-validated on
the way in and out of every node. This diagram follows one task's data through
those types.

```mermaid
flowchart TD
  msg["founder message"] --> pd{{"PlannerDecision<br/>(discriminated union)"}}
  pd -->|type: reply| rep["reply text → END"]
  pd -->|type: plan| plan["Plan<br/>goal + steps[] (≤8, unique step_id)"]

  plan --> env["TaskEnvelope (per step)<br/>step_id · worker · objective (≥8 chars)<br/>inputs · expected{kind, schema_ref}<br/>dependencies · constraints{max_tool_calls≤6, hitl_required}"]

  env --> worker["worker runs step<br/>(envelope-only context)"]
  worker --> receipts["ToolReceipt[]<br/>tool · args_hash · result_digest<br/>ok · at · idempotency_key"]

  worker --> sr{{"StepResult<br/>(discriminated on status)"}}
  sr -->|status: ok| okr["output + tool_receipts[]"]
  sr -->|status: failed| fail["FailureReport<br/>stage · component · message · evidence · retryable"]

  okr --> vsr["validateStepResult()"]
  receipts --> vsr
  vsr -->|"output ✓ schema_ref<br/>AND (kind≠action_receipt OR ok receipt exists)"| pass["accepted result"]
  vsr -->|"unproven action / bad shape"| reject["→ typed failure (never silently pass)"]

  pass --> synth["synthesize<br/>(validated results only)"]
  fail --> synth
  synth --> out["reply + receipts block"]

  classDef t fill:#eef,stroke:#66a;
  class pd,sr t;
```

## The contracts

| Type | Purpose | Key fields |
|------|---------|-----------|
| `PlannerDecision` | Reply-or-plan, decided once | `reply` \| `plan` |
| `Plan` | Ordered work | `goal`, `steps[]` (unique ids, ≤8) |
| `TaskEnvelope` | **The only thing a worker sees** | `objective`, `inputs`, `expected`, `constraints` |
| `ToolReceipt` | Code-recorded proof of a tool run | `args_hash`, `result_digest`, `ok`, `idempotency_key` |
| `StepResult` | Typed outcome | `ok{output, receipts}` \| `failed{failure}` |
| `FailureReport` | Honest failure | `stage`, `component`, `evidence`, `retryable` |

## The output contract

Each envelope names an `expected.schema_ref` (`text.summary`, `research.findings`, `draft.email`, `draft.linkedin_post`, `action.summary`, `data.generic`, or a `signal.*`). `validateStepResult()` parses the worker's output against that exact Zod schema. If `expected.kind === "action_receipt"`, the result **must** carry a successful `ToolReceipt` — an action claim without one is rejected as unproven. That single rule is the zero-hallucination guarantee. See [07 — Receipts & zero-hallucination](07-receipt-and-zero-hallucination.md).
