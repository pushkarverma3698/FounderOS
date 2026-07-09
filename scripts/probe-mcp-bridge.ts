/**
 * Probe: external MCP bridge against the keyless reference server (ADR-041).
 * Connects to @modelcontextprotocol/server-everything over real stdio, loads
 * its tools through buildBridgedTools, and prints each tool's namespaced name
 * and resolved read/write classification. No API keys, no LLM — proves the
 * load + classification + naming path end-to-end on a real server.
 *
 *   node --import tsx/esm scripts/probe-mcp-bridge.ts
 */

import { bridgeManifestSchema } from "../src/mcp/bridge-manifest.js";
import { buildBridgedTools } from "../src/mcp/client.js";
import { isWriteTool } from "../src/mcp/bridge-classify.js";

async function main() {
  const manifest = bridgeManifestSchema.parse({
    servers: {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        department: "personal",
        // Treat "echo" as a write to prove the gating classification fires.
        write: ["echo"],
      },
    },
  });

  console.log("Connecting to @modelcontextprotocol/server-everything …");
  const byDept = await buildBridgedTools(manifest);
  const tools = byDept["personal"] ?? [];

  if (tools.length === 0) {
    console.error("❌ No tools loaded — server failed to connect.");
    process.exit(1);
  }

  console.log(`\n✅ Loaded ${tools.length} tools into department "personal":\n`);
  for (const t of tools) {
    const bare = t.name.replace(/^mcp__everything__/, "");
    const gated = isWriteTool("everything", bare, manifest);
    console.log(`  ${gated ? "🔒 WRITE" : "👁  read "}  ${t.name}`);
  }

  const echo = tools.find((t) => t.name === "mcp__everything__echo");
  console.log(
    `\nClassification check: echo gated = ${
      echo ? isWriteTool("everything", "echo", manifest) : "MISSING"
    } (expected true)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
