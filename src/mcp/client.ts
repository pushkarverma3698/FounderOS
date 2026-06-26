/**
 * FounderOS — External MCP Client Bridge (ADR-041)
 * =================================================
 * Connects to external MCP servers declared in the bridge manifest and returns
 * their tools, each re-wrapped through gateMcpTool (reads pass through, writes
 * are HITL-gated). Maps every server's tools to the department(s) it declares.
 *
 * Failure isolation (rule #12, mirrors getGraph()'s connect-once discipline):
 *   - One MultiServerMCPClient with onConnectionError:"ignore" so a dead server
 *     never aborts the others at the transport layer.
 *   - Per-server try/catch around tool loading so a server that connects but
 *     fails to enumerate tools contributes ZERO tools instead of crashing boot.
 * A dead external server therefore degrades to "those tools are absent", never
 * to "FounderOS won't start".
 */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { Connection } from "@langchain/mcp-adapters";
import { childLogger } from "../infra/logger.js";
import { gateMcpTool, type LoadedMcpTool } from "../agents/agent-tools/external-mcp.js";
import { isWriteTool } from "./bridge-classify.js";
import { departmentsOf, type BridgeManifest, type McpServerEntry } from "./bridge-manifest.js";

const log = childLogger({ module: "mcp:client" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/** Build the stdio connection config, resolving forwarded env-var names to values. */
function toConnection(entry: McpServerEntry): Connection {
  const env: Record<string, string> = {};
  for (const name of entry.env) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
    else log.warn({ name }, "MCP server env var requested but unset");
  }
  return {
    transport: "stdio",
    command: entry.command,
    args: entry.args,
    ...(entry.env.length ? { env } : {}),
  };
}

/**
 * Connect to every server in the manifest and return department → bridged tools.
 * Servers that fail to connect or load contribute no tools (logged, not thrown).
 * Pass a client factory in tests to avoid spawning real processes.
 */
export async function buildBridgedTools(
  manifest: BridgeManifest,
  makeClient: (servers: Record<string, Connection>) => MultiServerMCPClient = (servers) =>
    new MultiServerMCPClient({
      mcpServers: servers,
      onConnectionError: "ignore",
      // We own naming/collision-safety in gateMcpTool — keep bare names here so
      // the manifest write allowlist matches, and disable the adapter's prefix.
      prefixToolNameWithServerName: false,
      additionalToolNamePrefix: "",
      throwOnLoadError: false,
    }),
): Promise<Record<string, AnyTool[]>> {
  const byDept: Record<string, AnyTool[]> = {};
  const entries = Object.entries(manifest.servers);
  if (entries.length === 0) return byDept;

  const servers: Record<string, Connection> = {};
  for (const [name, entry] of entries) servers[name] = toConnection(entry);

  const client = makeClient(servers);

  for (const [name, entry] of entries) {
    try {
      const loaded = (await client.getTools(name)) as unknown as LoadedMcpTool[];
      const wrapped = loaded.map((t) => gateMcpTool(t, name, manifest));
      for (const dept of departmentsOf(entry)) {
        (byDept[dept] ??= []).push(...wrapped);
      }
      // Log every tool's resolved gating so a missed write classification is
      // visible in boot logs (defense-in-depth for the allowlist, review M4).
      const classified = loaded.map((t) => `${t.name}=${isWriteTool(name, t.name, manifest) ? "WRITE" : "read"}`);
      log.info(
        { server: name, tools: loaded.length, departments: departmentsOf(entry), classified },
        "MCP server bridged",
      );
    } catch (err) {
      log.warn({ server: name, err: (err as Error).message }, "MCP server failed to load — skipped (isolated)");
    }
  }
  return byDept;
}

// ── Connect-once memoization ────────────────────────────────────────────────
// Cache the in-flight PROMISE, not the resolved value, so two concurrent callers
// at startup can never both spawn a full set of child-process connections (H2).
let inflight: Promise<Record<string, AnyTool[]>> | null = null;

/** Memoized accessor — connects once, reuses thereafter (rule #2). */
export async function getBridgedTools(manifest: BridgeManifest): Promise<Record<string, AnyTool[]>> {
  if (inflight) return inflight;
  inflight = buildBridgedTools(manifest);
  return inflight;
}

/** Test-only: reset the memoized cache. */
export function __resetBridgeCache(): void {
  inflight = null;
}
