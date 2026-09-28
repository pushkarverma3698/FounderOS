/**
 * A minimal stdio MCP server for hub-bridge tests: one read tool, one tool the
 * manifest lists as a write, one tool that only its annotation marks destructive.
 * Records every call it receives in $ECHO_CALLS, so a test can prove a refused
 * tool never reached it.
 */
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });
const obj = { type: "object", properties: { text: { type: "string" } } };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "echo", description: "Echo text back", inputSchema: obj, annotations: { readOnlyHint: true } },
    { name: "send_note", description: "Send a note", inputSchema: obj },
    { name: "wipe", description: "Delete everything", inputSchema: obj, annotations: { destructiveHint: true } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (process.env["ECHO_CALLS"]) appendFileSync(process.env["ECHO_CALLS"], `${req.params.name}\n`);
  const text = String((req.params.arguments ?? {})["text"] ?? "");
  return { content: [{ type: "text", text: `${req.params.name}:${text}` }] };
});

await server.connect(new StdioServerTransport());
