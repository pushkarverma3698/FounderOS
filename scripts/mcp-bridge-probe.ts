/**
 * MCP bridge probe (ADR-041) — reproducible evidence that the external-MCP
 * bridge connects to real servers and classifies their tools correctly.
 *
 * Exercises the PRODUCTION code path (loadManifest → buildBridgedTools →
 * gateMcpTool), not a mock. A dead server (blender without uvx, slack without a
 * token) is expected to be isolated and contribute zero tools; a reachable
 * server (DeepWiki over HTTP, no auth) loads its read tools. With --invoke, one
 * DeepWiki read tool is actually called so the output is live, not asserted.
 *
 *   node --import tsx/esm scripts/mcp-bridge-probe.ts [manifest.json] [--invoke]
 */

import { loadManifest } from "../src/mcp/bridge-manifest.js";
import { buildBridgedTools } from "../src/mcp/client.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const invoke = args.includes("--invoke");
  const manifestPath = args.find((a) => !a.startsWith("--")) ?? "mcp-bridge.json";

  console.log(`\n▶ MCP bridge probe — manifest: ${manifestPath}\n`);
  const manifest = loadManifest(manifestPath);
  console.log(`Declared servers: ${Object.keys(manifest.servers).join(", ")}\n`);

  const { byDept, gatedNames: gated } = await buildBridgedTools(manifest);
  const gatedNames = new Set(gated);

  let total = 0;
  for (const [dept, tools] of Object.entries(byDept)) {
    console.log(`■ department "${dept}" — ${tools.length} bridged tool(s)`);
    for (const t of tools) {
      total += 1;
      const gated = gatedNames.has(t.name) ? "WRITE (HITL-gated)" : "read (pass-through)";
      // Surface the raw server annotations so it's visible whether gating came
      // from the manifest write list or a server-declared hint (Tier 2).
      const ann = (t as { metadata?: { annotations?: unknown } }).metadata?.annotations;
      const annStr = ann && Object.keys(ann as object).length ? `  annotations=${JSON.stringify(ann)}` : "";
      console.log(`   • ${t.name}  →  ${gated}${annStr}`);
    }
  }
  if (total === 0) console.log("(no tools loaded — every declared server was unreachable/ isolated)");

  if (invoke) {
    const research = byDept["research"] ?? [];
    const readTool = research.find((t) => /read_wiki_structure$/.test(t.name));
    if (!readTool) {
      console.log("\n⚠ --invoke: no DeepWiki read_wiki_structure tool loaded; skipping live call.");
    } else {
      console.log(`\n▶ live call: ${readTool.name}({ repoName: "modelcontextprotocol/servers" })`);
      const out = await readTool.invoke({ repoName: "modelcontextprotocol/servers" });
      const text = typeof out === "string" ? out : JSON.stringify(out);
      console.log(`◀ result (${text.length} chars):\n${text.slice(0, 700)}${text.length > 700 ? "…" : ""}`);
    }
  }

  console.log(`\n✔ probe complete — ${total} tool(s) bridged across ${Object.keys(byDept).length} department(s).\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("✖ probe failed:", err);
  process.exit(1);
});
