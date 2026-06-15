# FounderOS — System Diagrams

> Every diagram here is **mermaid** (renders natively on GitHub). Read top to
> bottom: the first three explain *what the system is* and *how one message
> flows*; the rest are reference maps for a specific concern.
>
> These diagrams are the fast on-ramp for any developer. For prose, pair them
> with [../guides/ARCHITECTURE.md](../guides/ARCHITECTURE.md).

## Read in this order

| # | Diagram | Answers |
|---|---------|---------|
| 01 | [System architecture](01-system-architecture.md) | What are the moving parts and how do they connect? |
| 02 | [Request lifecycle](02-request-lifecycle.md) | What happens to ONE Telegram message, step by step? |
| 03 | [HITL approval flow](03-hitl-flow.md) | How does founder approval gate external actions? |
| 04 | [Department & tool map](04-department-tool-map.md) | Which department owns which tool, and what's gated? |
| 05 | [Deployment pipeline](05-deployment-pipeline.md) | How does a commit reach production? |
| 06 | [Data model](06-data-model.md) | What does Postgres store and why? |
| 07 | [Module layering](07-module-layering.md) | What can import what (the dependency rule)? |
| 08 | [Thread state machine](08-thread-state-machine.md) | What states can a per-chat thread be in, and how do the guards recover it? |

## The one-paragraph mental model

A Telegram message enters the **gateway** (`src/gateway/`). The gateway runs three
**thread guards** (resolve stale approval → recover wedged thread → capture turn
boundary), then invokes the **office** — a LangGraph `createSupervisor` graph
(`src/agents/office.ts`) compiled **once** with a Postgres checkpointer. The
supervisor routes to one of **7 ReAct departments**, each carrying real tools.
Any tool that touches the outside world (send email, post, push, write file, run
shell) **pauses** via native `interrupt()` and renders an Approve/Reject card.
Side effects run **only after approval**, and every send is **idempotency-audited**.
State persists in Postgres, so a pending approval **survives a process restart**.

## Keeping these current

These are hand-authored from the live code (not auto-generated). When you
add/remove a department or tool, update **04** and **01**. When you change the
run-loop guards, update **02** and **08**. The auto-generated topology graph at
[`.claude/graph-mermaid.md`](../../.claude/graph-mermaid.md) is a separate,
machine-generated view (regenerate with `pnpm graph:gen`).
