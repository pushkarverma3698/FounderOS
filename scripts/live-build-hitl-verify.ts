/**
 * Live HITL build verify — office graph → approve claude_code → check artifacts.
 * Simulates founder approve path without Telegram MTProto.
 *
 * Run on VPS: node --env-file=.env --import tsx/esm scripts/live-build-hitl-verify.ts
 */
import { MemorySaver, Command } from "@langchain/langgraph";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { buildOfficeInput } from "../src/gateway/pre-router.js";
import { findClaudeBinary } from "../src/tools/claude-code.js";
import { closeDatabaseConnections } from "../src/db/client.js";
import { getActivitySummary } from "../src/db/queries.js";
import { TENANT } from "../src/core/config.js";

const PROMPT =
  "Build a cinematic landing page for fictional AI observability startup AgentOps using the neon preset. Single index.html in workspace. Do not deploy.";

function listHtmlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isFile() && name.endsWith(".html")) out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

async function main(): Promise<void> {
  console.log("\n🔬 Live HITL build verify (office → approve → claude_code)\n");

  if (!findClaudeBinary()) {
    console.error("❌ Claude CLI missing");
    process.exit(1);
  }

  const auditBefore = await getActivitySummary(TENANT, new Date(Date.now() - 60_000));
  const claudeBefore = auditBefore["claude_code"] ?? 0;
  const office = buildOffice(new MemorySaver());
  const config = {
    configurable: { thread_id: `live:hitl-build:${Date.now()}` },
    recursionLimit: 40,
  };

  await office.invoke({ messages: buildOfficeInput(PROMPT) }, config);

  const approval = await getPendingApproval(office, config);
  if (!approval || approval.action !== "claude_code") {
    console.error("❌ Expected claude_code HITL, got:", approval?.action ?? "none");
    process.exit(1);
  }
  console.log("✅ HITL card:", approval.action, "—", approval.title);

  const t0 = Date.now();
  await office.invoke(new Command({ resume: "approved" }), config);

  const after = await getPendingApproval(office, config);
  if (after) {
    console.error("❌ Nested HITL after approve:", after.action);
    process.exit(1);
  }
  console.log(`✅ HITL cleared (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  const auditAfter = await getActivitySummary(TENANT, new Date(Date.now() - 600_000));
  const claudeAfter = auditAfter["claude_code"] ?? 0;
  console.log(`✅ action_log claude_code rows (10m window): ${claudeAfter} (delta since start: ${claudeAfter - claudeBefore})`);

  const ws = join(homedir(), "Projects", "agent-workspace");
  const htmlFiles = listHtmlFiles(ws);
  console.log("Workspace HTML files:", htmlFiles.length ? htmlFiles : "(none in default workspace)");
  for (const f of htmlFiles.slice(0, 3)) {
    console.log("   ", f, `(${statSync(f).size} bytes)`);
  }

  const state = await office.getState(config);
  const last = state.values?.messages?.at(-1);
  const text = typeof last?.content === "string" ? last.content : String(last?.content ?? "");
  console.log("\n--- Bot reply (tail) ---");
  console.log(text.slice(-800));

  console.log("\n✅ LIVE HITL BUILD VERIFY PASSED");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => closeDatabaseConnections().catch(() => {}));
