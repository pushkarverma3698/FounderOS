# Current State of FounderOS Tooling Architecture

## 1. Current Architecture

Currently, FounderOS implements tools as direct code objects implementing the `UnifiedTool` interface (`name`, `description`, `input_schema`, `execute`), which are then wrapped by LangChain adapters in `src/agents/agent-tools/` and statically wired into departments via `src/agents/capabilities.ts`.

The kernel reads these static capabilities in `src/gateway/kernel-boot.ts` (`buildWorkerSpecs()`) and provides them to the LangGraph workers (`src/kernel/worker.ts`).

There is no actual "Registry" logic for dispatch or abstraction over transports. Tools are imported and executed directly in the Node.js process. The execution mechanisms (transports) are hardcoded into the `execute` methods of the individual tools.

## 2. Current Tool Mechanisms & Transports

Tools are currently implemented via various mechanisms, but they all share the same TypeScript signature (`execute()`). The mechanisms include:
- **Internal Service/DB calls**: e.g., `searchMemoryTool`, `readContext`, `recordEvent`, `jobState`, `writeArtifact`. These interact directly with Postgres/pgvector via `src/db/` or `src/infra/`.
- **CLI / Runtime calls**: e.g., `claude_code` spawns the Claude Code CLI, `runShell` executes bash commands, `vpsRun` invokes SSH commands.
- **Browser Automation**: e.g., `browser` tool uses Playwright directly (`src/tools/browser-playwright.ts`).
- **HTTP / API calls**: e.g., `githubRead` / `githubWrite` use Octokit, `sendEmail` uses `gws-runner`, `generateImageTool`, LinkedIn tools, etc.
- **MCP Bridge**: External MCP tools are bridged via `src/mcp/client.ts` and injected into the department capability lists by `applyMcpBridge` mutating `DEPARTMENT_TOOLS` directly in `capabilities.ts`.

## 3. Duplicated Abstractions & Architectural Problems

- **No clear transport separation**: The `execute()` method of a tool handles business logic, transport logic (e.g. running `spawn()` or `fetch()`), and side effects.
- **Approval System coupling**: `HITL_GATED_TOOLS` is a static Set in `capabilities.ts`. Tools are manually wrapped by `hitlGate` in `src/agents/agent-tools/*.ts`. This means the capability of approval is defined externally in an array, while the implementation is a wrapper.
- **Runtime coupling**: FounderOS runs `claude_code` and `browser` natively inside its process via `spawn` and `playwright`. In a target generic-runtime future (e.g., OpenClaw, Antigravity running remotely), FounderOS should not be implementing a browser; it should just know the runtime *has* a browser.
- **Hardcoded Capabilities**: `DEPARTMENT_TOOLS` manually lists tools. There is no declarative registry to query "what tools have 'write' access?" or "what tools belong to the 'jobhunt' domain?".
- **Direct Invocation**: LangGraph workers directly invoke the tool object's `invoke` method. There's no central gateway intercepting all tool executions for observability, policy enforcement, or routing.

## 4. Direct Invocation Paths
1. `src/kernel/worker.ts`: `makeToolsNode` calls `tool.invoke(args)`.
2. `src/gateway/kernel-boot.ts`: Connects LangChain tool objects to the worker specs.
3. `src/agents/agent-tools/hitl.ts`: Wraps the invocation to throw `interrupt()` if gated.
4. `src/agents/capabilities.ts`: The static router map.

## 5. Recommended Migration Path

1. **Implement `ToolDefinition` and `ToolRegistry`**: A typed interface (Layer, Transport, SideEffect, Approval) and a centralized catalog.
2. **Implement `ToolGateway` and Adapters**: A central router `ToolGateway.invoke(id, args)`. Adapters (Internal, MCP, CLI) will perform the actual execution.
3. **Migrate Tool Registration**: Gradually move tools from `src/tools/*.ts` and `capabilities.ts` to register with `ToolRegistry`.
4. **Update `worker.ts`**: Have `makeToolsNode` resolve tools through `ToolGateway` rather than directly invoking `tool.invoke()`.
5. **Normalize Approval**: Move approval rules from the `HITL_GATED_TOOLS` hardcoded list to the `approval: "required"` field on `ToolDefinition`. The Gateway will enforce this via the `hitl` wrapper or adapter.
6. **Abstract Runtime Tools**: Expose descriptors for tools like `claude_code` or `browser` without coupling FounderOS to `playwright` or `spawn` directly.
