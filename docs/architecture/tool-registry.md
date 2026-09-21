# Tool Registry Architecture

## Overview
The `ToolRegistry` provides a single, unified catalog for all available tools across FounderOS, regardless of their underlying execution transport or environment. This separates the definition and discovery of tools from how they are actually run.

## Core Concepts

### ToolDefinition
Every tool in FounderOS is represented by a `ToolDefinition`, which details:
- `id`: Unique identifier for the tool.
- `name`: Name used by the LLM and system.
- `layer`: The conceptual layer the tool belongs to (`founderos`, `runtime`, `integration`, `infrastructure`).
- `transport`: How the tool is executed (`internal`, `mcp`, `http`, `cli`, `runtime`).
- `sideEffect`: Determines if the tool is `read`, `write`, or `destructive`.
- `approval`: Approval policy (`none`, `required`, `conditional`).

### ToolRegistry
The `ToolRegistry` is responsible for:
- Maintaining the catalog of all tools.
- Discovering capabilities.
- Providing schemas for the LangGraph workers.
It does **not** execute tools or perform side effects.

### ToolGateway
The `ToolGateway` is the central execution router:
- Receives execution requests.
- Validates the request against the tool's defined `approval` policy using the `hitlGate`.
- Dispatches the execution to the appropriate `ToolAdapter` via `ToolResolver`.

### ToolAdapter
Adapters (`Internal`, `MCP`, `CLI`, `Runtime`) act as the bridge between the logical tool and the physical execution.
- `InternalFunctionAdapter`: Executes tools that run as normal async Node functions.
- `McpAdapter`: For tools that run on MCP servers.
- `RuntimeAdapter`: Denotes tools native to the runtime environment (e.g. Claude Code filesystem tools).
