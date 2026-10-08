/**
 * FounderOS hub — one MCP server for every coding tool.
 * =====================================================
 * Claude Code, Codex, Cursor, Antigravity and Gemini all start the same process
 * on the VPS (over SSH, through ~/Projects/scripts/ai-tools/founderos-brain-mcp.sh),
 * so they share one brain, one set of Google accounts signed in once on the VPS,
 * and one list of connected MCP servers. Adding a server on the VPS reaches all
 * of them with no laptop edit.
 *
 *   scope "all"   brain + Gmail/Calendar reads + connected servers + FounderOS's own read-only
 *                 tools as fos_<tool> (hub-native.ts)
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
import type { NativeHubTools } from "./hub-native.js";

export const HUB_SCOPES = ["all", "brain"] as const;
export type HubScope = (typeof HUB_SCOPES)[number];

/** HUB_SCOPE from the environment; unset means "all". Anything else is a startup error. */
export function parseHubScope(raw: string | undefined): HubScope {
  const v = (raw ?? "all").trim().toLowerCase() || "all";
  if ((HUB_SCOPES as readonly string[]).includes(v)) return v as HubScope;
  throw new Error(`HUB_SCOPE must be one of ${HUB_SCOPES.join(", ")}; got "${raw}".`);
}

/** Native tools (AG-042) are served in scope all only, and only when the caller loaded them. */
export function hubTools(scope: HubScope, native?: NativeHubTools) {
  if (scope === "brain") return [...BRAIN_TOOLS];
  return [...BRAIN_TOOLS, ...GOOGLE_TOOLS, ...BRIDGE_TOOLS, ...(native?.tools ?? [])];
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

/** Appended to the scope-all instructions only when the native tools were loaded (AG-042). */
const NATIVE_NOTE =
  " The fos_* tools are FounderOS's own read-only tools, the same ones the Telegram bot uses " +
  "(fos_ops_state, fos_github_read, fos_read_logs, fos_list_*). They never send or change anything and " +
  "read no private chats; writes stay in Telegram, where he approves them.";

export interface HubOptions {
  scope: HubScope;
  google?: GoogleDeps;
  bridge?: BridgeDeps;
  /** FounderOS read-only tools (scope all only). Loaded by hub.ts; absent in brain scope. */
  native?: NativeHubTools;
}

export function buildHubServer(opts: HubOptions): Server {
  const native = opts.scope === "all" ? opts.native : undefined;
  const tools = hubTools(opts.scope, native);
  const allowed = new Set(tools.map((t) => t.name));
  const server = new Server(
    { name: "founderos-hub", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS[opts.scope] + (native ? NATIVE_NOTE : "") },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools as never }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    // Scope is enforced here, not only by the list: a client may call any name.
    if (!allowed.has(name)) return formatError(`Tool "${name}" is not available in this hub (scope: ${opts.scope}).`);
    const result: McpToolResult | null =
      (await callBrainTool(name, args)) ??
      (await callGoogleTool(name, args, opts.google)) ??
      (await callBridgeTool(name, args, opts.bridge)) ??
      (native ? await native.run(name, args) : null);
    return result ?? formatError(`Unknown tool: ${name}`);
  });

  return server;
}
