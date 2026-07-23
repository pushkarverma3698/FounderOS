# Diagrams

The FounderOS v3 architecture, drawn. All diagrams are Mermaid (render natively
on GitHub, export cleanly for slides and the Turicks site). Every one is grounded
in the actual source — file paths are linked inline.

## Understand the system

| # | Diagram | Shows |
|---|---------|-------|
| [01](01-system-architecture.md) | **System architecture** | Components and how they connect; the kernel-as-library boundary |
| [02](02-orchestration-path.md) | **Orchestration path** | The one control flow: plan → dispatch → agent ⇄ tools → collect → synthesize |
| [04](04-contract-dataflow.md) | **Contract data flow** | The task as a typed object at every boundary |
| [06](06-data-model.md) | **Data model** | What Postgres stores (`agents` + `brain` schemas) |

## Understand the guarantees

| # | Diagram | Shows |
|---|---------|-------|
| [03](03-hitl-flow.md) | **HITL approval flow** | How founder approval gates every external action (crash-safe) |
| [07](07-receipt-and-zero-hallucination.md) | **Receipts & zero-hallucination** | Why the system can't claim an action it didn't take |
| [08](08-anti-slop-ci-gates.md) | **Anti-slop CI gates** | The 6 machine-checked rules + the debt ratchet |

## The story & the shipping path

| # | Diagram | Shows |
|---|---------|-------|
| [09](09-v2-vs-v3.md) | **v2 vs v3** | The pivot, side by side (marketing showcase) |
| [10](10-capability-map.md) | **Capability map** | 8 workers, their tools, and the 17 HITL gates |
| [05](05-deployment-pipeline.md) | **Deployment pipeline** | How a commit reaches production (branch → beta → main → VPS) |

> The v2-era topology diagrams (old system architecture, department/tool map,
> module layering, thread state machine, request lifecycle through `office-run`)
> were retired with the v2 architecture on 2026-07-08. The numbers 01–10 above are
> the current v3 set.
