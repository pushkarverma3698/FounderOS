/**
 * Probe: browser-use MCP server (ADR-045) through the ADR-041 bridge.
 *
 * Two modes:
 *   1) connect (default) — loads the shipped `browser-use` server from
 *      mcp-bridge.json over real stdio, prints each tool's namespaced name and
 *      resolved read/write classification. Proves load + gating + naming without
 *      spending a single LLM token. Requires `uv`/`uvx` on PATH.
 *
 *   2) --live — additionally drives the AUTONOMOUS agent
 *      (retry_with_browser_use_agent) against a SAFE public site and prints the
 *      real extracted result. This is the one sanctioned paid step (rule #23):
 *      it costs a small amount of LLM tokens and needs OPENAI_API_KEY or
 *      ANTHROPIC_API_KEY set. The RAW MCP tool is called directly (bypassing the
 *      HITL wrapper) per TOOL-STANDARDS point 7.
 *
 *   node --env-file=.env --import tsx/esm scripts/probe-browser-use.ts [--live] ["goal"]
 */

import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { loadManifest } from "../src/mcp/bridge-manifest.js";
import { buildBridgedTools } from "../src/mcp/client.js";
import { isWriteTool } from "../src/mcp/bridge-classify.js";

const SERVER = "browser-use";

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const goal =
    args.find((a) => !a.startsWith("--")) ??
    "Go to https://news.ycombinator.com and return the titles and urls of the top 5 posts.";

  // Use the REAL shipped manifest so the probe reflects production config.
  const manifest = loadManifest("mcp-bridge.json");
  const entry = manifest.servers[SERVER];
  if (!entry) {
    console.error(`❌ No "${SERVER}" server in mcp-bridge.json.`);
    process.exit(1);
  }

  console.log(`Connecting to "${SERVER}" via: ${entry.command} ${entry.args.join(" ")} …`);
  const byDept = await buildBridgedTools(manifest);
  const tools = (byDept["personal"] ?? []).filter((t) => t.name.startsWith(`mcp__${SERVER}__`));

  if (tools.length === 0) {
    console.error(
      `❌ No ${SERVER} tools loaded — server failed to connect.\n` +
        `   Check that \`uvx\` is on PATH and \`uvx --from "browser-use[cli]" browser-use --mcp\` runs.`,
    );
    process.exit(1);
  }

  console.log(`\n✅ Loaded ${tools.length} ${SERVER} tools into department "personal":\n`);
  for (const t of tools) {
    const bare = t.name.replace(new RegExp(`^mcp__${SERVER}__`), "");
    const gated = isWriteTool(SERVER, bare, manifest);
    console.log(`  ${gated ? "🔒 WRITE" : "👁  read "}  ${t.name}`);
  }

  const agentGated = isWriteTool(SERVER, "retry_with_browser_use_agent", manifest);
  console.log(
    `\nClassification check: retry_with_browser_use_agent gated = ${agentGated} (expected true)`,
  );
  if (!agentGated) {
    console.error("❌ The autonomous agent is NOT gated — it would skip the founder HITL card.");
    process.exit(1);
  }

  if (!live) {
    console.log("\n(connect-only mode — pass --live to run the autonomous agent for real.)");
    process.exit(0);
  }

  // ── Live autonomous run (paid) ─────────────────────────────────────────────
  if (!process.env["OPENAI_API_KEY"] && !process.env["ANTHROPIC_API_KEY"]) {
    console.error("❌ --live needs OPENAI_API_KEY or ANTHROPIC_API_KEY set.");
    process.exit(1);
  }

  console.log(`\n🌐 LIVE autonomous run — goal:\n   "${goal}"\n`);
  // Raw client so we invoke the underlying MCP tool directly (no HITL wrapper).
  const env: Record<string, string> = {};
  for (const name of entry.env) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  const raw = new MultiServerMCPClient({
    mcpServers: {
      [SERVER]: { transport: "stdio", command: entry.command, args: entry.args, env },
    },
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: "",
    throwOnLoadError: false,
  });
  const rawTools = await raw.getTools(SERVER);
  const agent = rawTools.find((t) => t.name === "retry_with_browser_use_agent");
  if (!agent) {
    console.error("❌ retry_with_browser_use_agent not found on the raw server.");
    process.exit(1);
  }

  const started = Date.now();
  const result = await agent.invoke({ task: goal });
  console.log(`\n✅ Agent finished in ${((Date.now() - started) / 1000).toFixed(1)}s. Result:\n`);
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  await raw.close?.();
  process.exit(0);
}

main().catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
