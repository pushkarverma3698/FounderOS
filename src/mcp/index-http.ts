/**
 * FounderOS MCP Server — HTTP Entry Point (spec §1.2, item 6)
 * ===========================================================
 * Starts the read-only MCP server on a Streamable HTTP transport bound to
 * loopback, gated by a bearer token. This is the VPS-side counterpart to the
 * stdio entry (src/mcp/index.ts, used by local Claude Code): the Mac reaches it
 * through an SSH local-forward (`ssh -N -L 3100:127.0.0.1:3100`).
 *
 * Run: pnpm mcp:http   (or: node --env-file=.env --import tsx/esm src/mcp/index-http.ts)
 * Requires: FOUNDEROS_MCP_TOKEN (>=16 chars — `openssl rand -hex 32`).
 * Optional: FOUNDEROS_MCP_PORT (default 3100), FOUNDEROS_MCP_HOST (default
 *           127.0.0.1), FOUNDEROS_MCP_ALLOW_PUBLIC=1 to bind a public address.
 *
 * See docs/VPS-MCP-SETUP.md for the systemd unit and the Mac autossh tunnel.
 */

import { startMcpHttpServer } from "./http.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "mcp:http" });

function main() {
  const server = startMcpHttpServer();

  const shutdown = () => {
    log.info("MCP HTTP server shutting down");
    server.close(() => process.exit(0));
    // Force-exit if connections don't drain promptly.
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

try {
  main();
} catch (err) {
  console.error("MCP HTTP server failed to start:", (err as Error).message);
  process.exit(1);
}
