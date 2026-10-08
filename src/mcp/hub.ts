/**
 * FounderOS hub — stdio entry point (see hub-server.ts for what it serves).
 * ========================================================================
 * Every coding tool starts it on the VPS over SSH:
 *   ssh founderos-vps 'cd /opt/founderos && LOG_STDERR=1 node --env-file=.env --import tsx/esm src/mcp/hub.ts'
 * HUB_SCOPE=brain limits it to the brain tools. LOG_STDERR=1 is required:
 * stdout is the JSON-RPC stream.
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logger } from "../infra/logger.js";
import { buildHubServer, hubTools, parseHubScope, type HubScope } from "./hub-server.js";
import { closeBridgeConnections } from "./hub-bridge.js";
import { loadNativeHubTools, type NativeHubTools } from "./hub-native.js";

const log = logger.child({ module: "mcp-hub" });

/** FounderOS's own read tools. A load failure costs only these tools, never the brain or Google ones. */
async function loadNative(): Promise<NativeHubTools | undefined> {
  try {
    return await loadNativeHubTools();
  } catch (err) {
    // allow-failopen: the failure is logged at error level and only withholds the fos_ tools (the closed direction).
    log.error({ err }, "FounderOS native tools not loaded; serving the rest of the hub");
    return undefined;
  }
}

export async function runHubStdio(scope: HubScope): Promise<void> {
  const native = scope === "all" ? await loadNative() : undefined;
  const server = buildHubServer(native ? { scope, native } : { scope });
  await server.connect(new StdioServerTransport());
  log.info({ scope, tools: hubTools(scope, native).map((t) => t.name) }, "FounderOS hub started (stdio)");
  const shutdown = async () => {
    await closeBridgeConnections();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Serve only when started as the entry file, not when imported (turicks-brain.ts, tests).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runHubStdio(parseHubScope(process.env["HUB_SCOPE"])).catch((err) => {
    console.error("FounderOS hub failed to start:", err);
    process.exit(1);
  });
}
