# Tool Registry Migration

## Target Architecture
The unified `ToolRegistry` manages tool definitions and discovering capabilities.
`ToolGateway` intercepts tool invocations, handles approval checks, and routes to the appropriate transport adapter.

## Migration Strategy
We are moving from hardcoded static imports of `UnifiedTool` objects in `src/agents/agent-tools/*.ts` to central registry lookups and Gateway invocation.

For each tool, the migration path is:
1. **Define ToolDefinition**: Add the tool definition to `src/tools/registry/init.ts` or a domain-specific registry module.
2. **Register**: The initialization process registers the tool with `ToolRegistry`.
3. **Adapter**: Map the tool to an adapter (`Internal`, `MCP`, `CLI`, `Runtime`). For existing tools that have complex execution logic in `execute()`, they can be mapped to the `InternalFunctionAdapter`.
4. **Update Callers**: Update the LangChain wrapper in `src/agents/agent-tools/*.ts` to call `toolGateway.invoke("tool_id", args)` instead of `tool.execute(args)`.
5. **Approval Policies**: Moving forward, the gateway can enforce `hitlGate` based on `ToolDefinition.approval`. Currently, `hitlGate` remains in the LangChain wrappers for backwards compatibility, but `ToolGateway` provides a seam to lift this logic.

## Migrated Tools
| Tool Name | Tool ID | Layer | Transport | Side Effect | Approval Policy | Migration Status |
|-----------|---------|-------|-----------|-------------|-----------------|------------------|
| claude_code | claude_code | runtime | internal | write | required | Migrated (PoC) |
| vps_run | vps_run | infrastructure | internal | write | required | Migrated (PoC) |
| browser | browser | runtime | internal | write | required | Migrated (PoC) |

## Remaining Tools
- *All other tools in `src/agents/agent-tools/*.ts`.*
- These tools continue to function exactly as before using direct invocation. They should be migrated one by one following the same pattern.
