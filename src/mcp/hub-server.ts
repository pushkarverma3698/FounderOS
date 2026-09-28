/**
 * FounderOS hub — one MCP server for every coding tool.
 * =====================================================
 * Claude Code, Codex, Cursor, Antigravity and Gemini all start the same process
 * on the VPS (over SSH, through ~/Projects/scripts/ai-tools/founderos-brain-mcp.sh),
 * so they share one brain, one set of Google accounts signed in once on the VPS,
 * and one list of connected MCP servers. Adding a server on the VPS reaches all
 * of them with no laptop edit.
 *
 *   scope "all"   brain + Gmail/Calendar reads + connected servers (the founder's tools)
 *   scope "brain" brain only — for an agent that must not read the founder's mail,
 *                 e.g. the VPS `antigravity` user, which runs it with its own
 *                 least-privilege database role
 *
 * Everything that sends or changes something on the founder's behalf stays in
 * Telegram, where he approves it (ADR-004, ADR-013). Brain writes are the one
 * exception, as before: they record decisions and bugs, not actions.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { BRAIN_TOOLS, callBrainTool, formatError, type McpToolResult } from "./brain-tools.js";
import { GOOGLE_TOOLS, callGoogleTool, type GoogleDeps } from "./hub-google.js";
import { BRIDGE_TOOLS, callBridgeTool, type BridgeDeps } from "./hub-bridge.js";

export const HUB_SCOPES = ["all", "brain"] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

/** HUB_SCOPE from the environment; unset means "all". Anything else is a startup error. */
export function parseHubScope(raw: string | undefined): HubScope {
  const v = (raw ?? "all").trim().toLowerCase() || "all";
  if ((HUB_SCOPES as readonly string[]).includes(v)) return v as HubScope;
  throw new Error(`HUB_SCOPE must be one of ${HUB_SCOPES.join(", ")}; got "${raw}".`);
}

export function hubTools(scope: HubScope) {
  return scope === "brain" ? [...BRAIN_TOOLS] : [...BRAIN_TOOLS, ...GOOGLE_TOOLS, ...BRIDGE_TOOLS];
}

const INSTRUCTIONS: Record<HubScope, string> = {
  all:
    "FounderOS hub on the founder's VPS. search_memory before non-trivial work and save_decision / save_bug " +
    "after (always pass the project tag). gmail_search and calendar_events read the founder's Google " +
    "accounts. list_connected_tools shows the other MCP servers. Nothing here sends or changes anything on " +
    "the founder's behalf; for that, ask FounderOS in Telegram, where he approves it.",
  brain:
    "The shared brain on the founder's VPS. search_memory before non-trivial work and save_decision / " +
    "save_bug after; always pass the project tag.",
};

export interface HubOptions {
  scope: HubScope;
  google?: GoogleDeps;
  bridge?: BridgeDeps;
}

export function buildHubServer(opts: HubOptions): Server {
  const tools = hubTools(opts.scope);
  const allowed = new Set(tools.map((t) => t.name));
  const server = new Server(
    { name: "founderos-hub", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS[opts.scope] },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Scope is enforced here, not only by the list: a client may call any name.
    if (!allowed.has(name)) return formatError(`Tool "${name}" is not available in this hub (scope: ${opts.scope}).`);
    const result: McpToolResult | null =
      (await callBrainTool(name, args)) ??
      (await callGoogleTool(name, args, opts.google)) ??
      (await callBridgeTool(name, args, opts.bridge));
    return result ?? formatError(`Unknown tool: ${name}`);
  });

  return server;
}
