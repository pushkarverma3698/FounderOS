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

const log = logger.child({ module: "mcp-hub" });

export async function runHubStdio(scope: HubScope): Promise<void> {
  const server = buildHubServer({ scope });
  await server.connect(new StdioServerTransport());
  log.info({ scope, tools: hubTools(scope).map((t) => t.name) }, "FounderOS hub started (stdio)");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await closeBridgeConnections();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The ssh session ending closes stdin. Without this, an open bridge child keeps
  // the hub alive after its laptop session is gone (AG-052).
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
}

// Serve only when started as the entry file, not when imported (turicks-brain.ts, tests).
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runHubStdio(parseHubScope(process.env["HUB_SCOPE"])).catch((err) => {
    console.error("FounderOS hub failed to start:", err);
    process.exit(1);
  });
}
