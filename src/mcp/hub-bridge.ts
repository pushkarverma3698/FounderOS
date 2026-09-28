/**
 * FounderOS hub — the MCP servers connected on the VPS, through two tools.
 * =======================================================================
 * The servers in the bridge manifest (mcp-bridge.json, ADR-041) reach every
 * coding tool through `list_connected_tools` and `call_connected_tool`, instead
 * of each server's tools being copied into every client:
 *   - a client's context cost stays at two tool schemas however many servers
 *     are added;
 *   - nothing connects until a server is actually used, so the hub starts fast;
 *   - the manifest is re-read on every call, so a server added on the VPS
 *     reaches every tool without a restart or a laptop edit.
 *
 * Read-only: a tool the bridge classifies as a write (manifest `write` list,
 * `gateUnlisted`, or a destructive/not-read-only annotation — the same
 * isWriteTool() the Telegram bridge gates on) is refused here, because approval
 * exists only in the Telegram gateway (ADR-004, ADR-013).
 */

import { isWriteTool, type ToolAnnotations } from "./bridge-classify.js";
import { loadManifest, type BridgeManifest, type McpServerEntry } from "./bridge-manifest.js";
import { formatError, formatResult, type McpToolResult } from "./brain-tools.js";

export const BRIDGE_TOOLS = [
  {
    name: "list_connected_tools",
    description:
      "MCP servers connected to FounderOS on the VPS, shared by every coding tool. With no argument, " +
      "lists the servers. With `server`, lists that server's tools and their input schemas; call one " +
      "with call_connected_tool. Tools that send or change something are marked Telegram-only.",
    inputSchema: {
      type: "object",
      properties: { server: { type: "string", description: "A server name from the list" } },
    },
  },
  {
    name: "call_connected_tool",
    description:
      "Call a read-only tool on a connected MCP server (see list_connected_tools). Tools that send or " +
      "change something are refused here; ask FounderOS in Telegram, which asks the founder to approve.",
    inputSchema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Server name" },
        tool: { type: "string", description: "Tool name on that server" },
        arguments: { type: "object", description: "The tool's arguments, per its input schema" },
      },
      required: ["server", "tool"],
    },
  },
];

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: ToolAnnotations;
}

/** The slice of the MCP SDK Client the bridge uses (a fake in tests). */
export interface BridgeClient {
  listTools(): Promise<{ tools: RemoteTool[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface BridgeDeps {
  manifest: () => BridgeManifest;
  connect: (name: string, entry: McpServerEntry) => Promise<BridgeClient>;
}

const CONNECT_TIMEOUT_MS = 20_000;

/** Real connections through the MCP SDK; loaded lazily so an unused bridge costs nothing. */
async function sdkConnect(name: string, entry: McpServerEntry): Promise<BridgeClient> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { toConnection } = await import("./client.js");
  const conn = toConnection(entry) as Record<string, unknown>;
  const client = new Client({ name: `founderos-hub:${name}`, version: "1.0.0" });
  let transport;
  if (entry.transport === "http") {
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const headers = (conn["headers"] ?? {}) as Record<string, string>;
    transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers } });
  } else {
    const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
      // The SDK replaces the child env when one is given: keep its safe defaults (PATH…).
      env: { ...getDefaultEnvironment(), ...((conn["env"] ?? {}) as Record<string, string>) },
      stderr: "ignore",
    });
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return client as unknown as BridgeClient;
}

const defaultDeps: BridgeDeps = {
  manifest: () => loadManifest(process.env["MCP_BRIDGE_MANIFEST"] ?? "mcp-bridge.json"),
  connect: sdkConnect,
};

/** One connection per server per hub process, shared by concurrent callers. */
const connections = new Map<string, Promise<BridgeClient>>();

function clientFor(name: string, entry: McpServerEntry, deps: BridgeDeps): Promise<BridgeClient> {
  let c = connections.get(name);
  if (!c) {
    c = deps.connect(name, entry);
    connections.set(name, c);
    // A failed connect is not cached: the next call tries again.
    // allow-failopen: every caller awaits `c` itself and still gets the rejection; this only evicts it.
    c.catch(() => connections.delete(name));
  }
  return c;
}

/** Test seam, and the hub's shutdown path. */
export async function closeBridgeConnections(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.allSettled(all.map(async (c) => (await c).close()));
}

function serverList(manifest: BridgeManifest): string {
  const names = Object.keys(manifest.servers);
  if (names.length === 0) return "No MCP servers are connected on the VPS yet (mcp-bridge.json is empty).";
  return names
    .map((n) => {
      const e = manifest.servers[n]!;
      return `- ${n} (${e.transport === "http" ? e.url : `${e.command} ${e.args.join(" ")}`})`;
    })
    .join("\n");
}

function isWrite(server: string, tool: RemoteTool, manifest: BridgeManifest): boolean {
  return isWriteTool(server, tool.name, manifest, tool.annotations);
}

/** Runs one bridge tool. Returns null for a name that is not a bridge tool. */
export async function callBridgeTool(
  name: string,
  args: Record<string, unknown>,
  deps: BridgeDeps = defaultDeps,
): Promise<McpToolResult | null> {
  if (name !== "list_connected_tools" && name !== "call_connected_tool") return null;

  let manifest: BridgeManifest;
  try {
    manifest = deps.manifest();
  } catch (err) {
    return formatError(`Could not read the MCP server list on the VPS: ${(err as Error).message}`);
  }

  const server = args["server"] === undefined ? undefined : String(args["server"]);
  if (name === "list_connected_tools" && !server) return formatResult(serverList(manifest));

  const entry = server ? manifest.servers[server] : undefined;
  if (!server || !entry) {
    return formatError(`Unknown server "${server ?? ""}". Connected servers:\n${serverList(manifest)}`);
  }

  let tools: RemoteTool[];
  let client: BridgeClient;
  try {
    client = await clientFor(server, entry, deps);
    tools = (await client.listTools()).tools;
  } catch (err) {
    return formatError(`Could not reach "${server}": ${(err as Error).message}`);
  }

  if (name === "list_connected_tools") {
    const lines = tools.map((t) =>
      isWrite(server, t, manifest)
        ? `### ${t.name} — Telegram-only (sends or changes something)\n${t.description ?? ""}`
        : `### ${t.name}\n${t.description ?? ""}\ninput schema: ${JSON.stringify(t.inputSchema ?? {})}`,
    );
    return formatResult(lines.join("\n\n") || `"${server}" exposes no tools.`);
  }

  const toolName = String(args["tool"] ?? "");
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) {
    return formatError(`"${server}" has no tool "${toolName}". It has: ${tools.map((t) => t.name).join(", ")}`);
  }
  if (isWrite(server, tool, manifest)) {
    return formatError(
      `"${toolName}" on ${server} sends or changes something on the founder's behalf, so it is refused ` +
        "here. Ask FounderOS in Telegram, which asks the founder to approve.",
    );
  }
  const toolArgs = (args["arguments"] && typeof args["arguments"] === "object" ? args["arguments"] : {}) as Record<
    string,
    unknown
  >;
  try {
    return (await client.callTool({ name: toolName, arguments: toolArgs })) as McpToolResult;
  } catch (err) {
    return formatError(`${server}/${toolName} failed: ${(err as Error).message}`);
  }
}
