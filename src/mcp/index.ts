/**
 * FounderOS MCP Server — Entry Point
 * ===================================
 * Starts the MCP server on Streamable HTTP transport.
 * Run: node --env-file=.env --import tsx/esm src/mcp/index.ts
 *  or: pnpm mcp
 *
 * Clients configure it with:
 *   {
 *     "mcpServers": {
 *       "founderos": {
 *         "command": "node",
 *         "args": ["--env-file=.env", "--import", "tsx/esm", "src/mcp/index.ts"],
 *         "cwd": "/path/to/founderos"
 *       }
 *     }
 *   }
 *
 * Or use the project's .mcp.json (auto-discovered by Claude Code).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./server.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "mcp" });

async function main() {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  log.info(
    {
      tools: ["search_web", "github_read", "read_context"],
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
