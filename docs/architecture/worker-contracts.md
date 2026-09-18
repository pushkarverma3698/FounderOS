# Worker Contract Architecture

> Milestone 2 of the FounderOS general-purpose AI OS migration.

This document describes the architectural pattern for persistent digital workers in FounderOS. A worker is an autonomous entity that operates on behalf of the founder to achieve specific business objectives over time.

## 1. Core Principle: The Portable Contract

The cornerstone of the worker architecture is the **Worker Contract**.

The contract is the portable identity and authority boundary for a digital employee. It defines WHO the worker is, WHAT it exists to achieve, WHAT responsibilities it owns, and WHICH capabilities it may use.

**Crucially, the contract does NOT define:**
- **How to execute:** There are no LLM prompts, chains, or LangGraph state machines in the contract.
- **Where to execute:** The contract does not depend on Antigravity, Claude Code, or OpenClaw.
- **Temporary tasks:** The contract is durable; it does not change when the worker is given a new ad-hoc task.

## 2. Persistence Readiness

Milestone 2 provides **runtime-independent worker definitions + lifecycle foundation**.

- **Contract** = durable in Git (for this milestone)
- **Worker runtime state** = temporary/in-memory for Milestone 2
- **Business/missions** = existing persistent FounderOS state
- **Full worker persistence** = later milestone (Milestone 3)

The Drizzle schemas (`worker_contracts`, `worker_state`, `worker_objectives`, `worker_progress`) are defined to establish the shape of future persistence, but runtimes remain in-memory for this milestone.

## 3. The Three Context Layers

FounderOS separates state into three distinct layers to allow runtimes to be stateless, ephemeral, and replaceable.

### Layer 1: The Worker Contract (Durable Identity)
- Owned by FounderOS.
- Contains: Identity, role, purpose, durable responsibilities, capabilities, and permissions.
- Versioned via semver (e.g. `1.0.0`).

### Layer 2: The Working Context (Temporary & Dynamic)
- Owned by the Runtime (e.g., Claude Code, Antigravity).
- Contains: Current active task, step-by-step reasoning, scratchpad, open tool calls, short-term conversational history.
- **Volatile:** If the runtime crashes, this state is lost.

### Layer 3: FounderOS Durable State (The Source of Truth)
- Owned by FounderOS.
- Contains: The database, personal RAG, turicks-brain, episodic memory, job applications, scheduled posts, and missions.
- **Persistent:** The runtime reads from and writes to this layer via specific bounded tools.

`WorkerContextProvider` exposes a tiny, focused bootstrap context (identity, current objective, task, recent state), while heavy data (e.g., memory, company context) is retrieved on-demand via tools like `search_worker_memory`.

## 4. Capability Resolution & Permission Hierarchy

Tool Registry + Capability Mappings is the future source of truth. (`DEPARTMENT_TOOLS` in LangGraph is a legacy compatibility layer during migration).

Permission evaluation follows a strict hierarchy to ensure workers do not inherit tools merely because a capability maps to them:

**Worker Capability → Resolved Tool → Tool Policy → Approval → Execution**

For example:
```
career_operator
   │
   └── career.outreach ✅ (Capability authorization)
             │
             └── send_email ✅ (Tool resolution)
                       │
                       └── approval required (Tool authorization via ToolRegistry)
                               │
                               └── ToolGateway (Execution)
```

1. Contract declares capabilities: `["career.outreach"]`
2. Contract permissions authorize the capability: `approvalRequired: ["career.outreach"]`
3. `CapabilityResolver` maps capability to tools: `["send_email"]`
4. Manifest Builder consults `ToolRegistry` for tool authorization policies.
5. The Runtime receives a `WorkerToolManifest` stripping all transport details.
6. The `ToolGateway` enforces execution policies (e.g., HITL gates).

## 5. Target Architecture

```text
                         FOUNDEROS
                            │
                ┌───────────┴───────────┐
                │     Worker Contract   │
                │                       │
                │ identity              │
                │ purpose               │
                │ responsibilities      │
                │ objectives            │
                │ constraints           │
                │ capabilities          │
                │ permissions           │
                └───────────┬───────────┘
                            │
                    Capability Resolver
                            │
                    Scoped Tool Manifest
                            │
                       Runtime Adapter
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         Antigravity    Claude Code    OpenClaw
              │
              ▼
        runtime-native tools
              +
        FounderOS capabilities
              │
              ▼
       FounderOS ToolGateway
              │
              ▼
        External world
```

Underneath, FounderOS state maintains durable continuity:
`Missions` | `Objectives` | `Tasks` | `Memory` | `Events` | `Artifacts` | `Business State`
