# FounderOS — FAQ

Recurring questions, answered plainly. For terms, see [CONCEPTS.md](CONCEPTS.md).

### What is FounderOS, in one sentence?
A deterministic agent kernel with a Telegram gateway that takes real business
actions — email, LinkedIn, GitHub, shell — safely, with founder approval and a
receipt for every action.

### How is this different from a LangChain/AutoGPT-style agent?
Three ways: (1) the supervisor is **pure code**, not an LLM, so routing is
deterministic and testable; (2) every boundary is a **typed contract**, not a
prose handoff; (3) actions require **code-recorded receipts**, so the agent can't
hallucinate that it did something. See [ARCHITECTURE.md](ARCHITECTURE.md).

### Does it act on its own without me?
No. All 17 write/send/spend/deploy tools pause for your approval via a Telegram
card. Read-only tools (search, read, analytics) run without a gate.

### What stops it from claiming it did something it didn't?
An action step is rejected unless it carries a successful, code-authored
`ToolReceipt`, and the reply-writer only sees validated results. → [diagram
07](diagrams/07-receipt-and-zero-hallucination.md).

### What happens if the process crashes mid-approval?
Nothing is lost. The approval row is written to Postgres *before* the graph pauses,
and graph state is checkpointed, so a restart resumes cleanly. The side effect only
runs after you approve.

### Can it double-send an email if I approve twice or it retries?
No. A stable idempotency key is checked against `action_log` before every send; a
duplicate finds the prior audit row and is skipped.

### Why Gemini Flash and not a bigger model?
Temperature-0 Gemini Flash tool-calls cleanly on-box, is fast and cheap, and the
architecture's determinism comes from *code*, not the model. There's a fallback
chain (`src/agents/model.ts`) and the model is swappable at the one composition
root (`kernel-boot.ts`).

### Is it multi-tenant?
No — it's single-founder by design. A SaaS pivot would require adding per-tenant
isolation (see [THREAT-MODEL.md](THREAT-MODEL.md), T6).

### What was "v2" and why did you rebuild it?
v2 was a LangGraph supervisor + 7 ReAct departments that lost complex tasks within
three steps (regex pre-router, empty-argument handoffs, a 77-regex post-hoc guard
that sometimes wiped the thread). The full story is in the
[case studies](turicks-case-studies/); the audit is in
[`ZERO-BASE-AUDIT.md`](../ZERO-BASE-AUDIT.md).

### How do you keep it from getting bloated again?
Six CI rules (`scripts/verify-architecture.ts`): tombstones, regex-routing = 0,
gateway-imports = 0, kernel-purity = 0, a 400-line file budget, and a fail-open
tax — with a debt baseline that may only shrink. → [diagram
08](diagrams/08-anti-slop-ci-gates.md).

### How much does development cost to run?
`pnpm test` is **$0** — the full graph runs offline with scripted models. Live
model calls happen only at milestone gates (`pnpm eval`, `pnpm qa:telegram`).

### Can external tools read FounderOS state?
Yes, read-only, via the MCP server (`src/mcp/`). There is no external write path.

### Where do I start reading the code?
[`src/kernel/contracts.ts`](../src/kernel/contracts.ts) (the contracts are the
architecture) → [`src/kernel/graph.ts`](../src/kernel/graph.ts) (the one path) →
[`src/gateway/kernel-boot.ts`](../src/gateway/kernel-boot.ts) (composition) →
[`tests/unit/kernel/kernel-e2e.test.ts`](../tests/unit/kernel/kernel-e2e.test.ts).

### How do I add a tool or a capability?
Follow the wiring map in [rules/PROGRAMMING-RULES.md](rules/PROGRAMMING-RULES.md).
Declare it in [`capabilities.ts`](../src/agents/capabilities.ts) (the single
source of truth) and gate it in `HITL_GATED_TOOLS` if it acts externally.

### It gave a wrong or "stalled" answer — where do I look?
Failures are typed and surfaced with a `stage` + `component`. Start with
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
