# FounderOS Layer Boundaries

To turn FounderOS into a general-purpose AI operating system that manages persistent digital workers, the architecture is divided into the following conceptual layers:

## 1. Control Plane (`src/kernel/`, `src/gateway/`, `src/agents/`)
Owns:
- Workers and worker lifecycle
- Missions, objectives, tasks
- Scheduling, approvals, and verification
- Orchestration and graph progress

## 2. State Plane (`src/db/`)
Owns:
- PostgreSQL and pgvector access
- Structured business state
- Durable memory
- Events and receipts
- Artifacts
- Persistent organizational knowledge

## 3. Tool Plane (`src/tools/registry/`, `src/tools/gateway/`, `src/tools/adapters/`)
Owns:
- **ToolDefinition**: The strongly typed unified schema for a tool.
- **ToolRegistry**: The catalog for registering, discovering, and querying tool capabilities.
- **ToolGateway / Executor**: Handles execution requests, checking policies and resolving the correct adapter.
- **Adapters**: Translate the standard `execute()` call into the specific transport logic (HTTP, CLI, MCP).
- **Tool Policies**: Side effects and approval requirements.

## 4. Runtime Plane (`src/runtimes/`)
Represents external execution runtimes (e.g., Claude Code, Google Antigravity, OpenClaw).
Owns:
- Reasoning and planning
- Working context
- Native shell, filesystem, and browser/computer-use capabilities
- Runtime-specific tool execution and session state

*FounderOS does not duplicate runtime-native tools, but exposes their descriptors in the unified registry.*

## 5. Infrastructure Plane (`src/infra/`)
Owns:
- VPS integrations
- Docker/container execution
- Processes, networking, deployment infrastructure
- Isolated execution environments
