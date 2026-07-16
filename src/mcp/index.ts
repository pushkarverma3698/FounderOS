/**
 * FounderOS MCP Server — stdio Entry Point
 * =========================================
 * Serves the read-only MCP tools over the STDIO transport: JSON-RPC on stdin/
 * stdout, one server per client process. Two ways to run it:
 *
 *   Local (same machine as the client):
 *     Claude Code / Desktop launch it via .mcp.json — see docs/VPS-MCP-SETUP.md.
 *
 *   Remote (client on your Mac, server + data on the VPS) — the simple bridge:
 *     the client launches this over SSH, so your existing SSH key is the auth
 *     and the VPS's own .env supplies every tool credential. No open port, no
 *     token, no tunnel daemon — the connection lives only while the client runs:
 *       { "mcpServers": { "founderos-vps": {
 *           "command": "ssh",
 *           "args": ["founderos-vps",
 *                    "cd /opt/founderos && LOG_STDERR=1 node --env-file=.env --import tsx/esm src/mcp/index.ts"] } } }
 *
 * Run locally: pnpm mcp  (sets LOG_STDERR=1 so logs go to stderr and stdout
 * stays pure JSON-RPC — mandatory for the stdio transport).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, FOUNDEROS_MCP_TOOLS } from "./server.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "mcp" });

async function main() {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // NOTE: logs go to stderr (LOG_STDERR=1) — stdout is reserved for JSON-RPC.
  log.info(
    {
      tools: FOUNDEROS_MCP_TOOLS.map((t) => t.name),
      transport: "stdio",
    },
    "FounderOS MCP server started (stdio transport)",
  );

  // Keep alive — the process exits when the transport closes.
  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("MCP server failed to start:", err);
  process.exit(1);
});
