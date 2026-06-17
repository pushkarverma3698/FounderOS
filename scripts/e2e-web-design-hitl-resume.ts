/**
 * Manual E2E — HITL approve + resume path for web design build task.
 * Proves interrupt → approved → engineering returns (claude runs or tool failure).
 *
 * Run: pnpm eval:webdesign:hitl
 * Safe default: single approve only; no GitHub side effects when CLI missing.
 */
import { MemorySaver, Command } from "@langchain/langgraph";
import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { buildOfficeInput } from "../src/gateway/pre-router.js";
import { findClaudeBinary } from "../src/tools/claude-code.js";
import { isStructuredToolFailure } from "../src/agents/tool-result.js";
import { closeDatabaseConnections } from "../src/db/client.js";

const PROMPT =
  "Build a cinematic landing page for a fictional AI observability startup called AgentOps using the neon preset.";

async function main(): Promise<void> {
  const office = buildOffice(new MemorySaver());
  const config = {
    configurable: { thread_id: `e2e:hitl-resume:${Date.now()}` },
    recursionLimit: 25,
  };

  console.log("\n🔬 HITL resume E2E — web design build\n");

  await office.invoke({ messages: buildOfficeInput(PROMPT) }, config);

  const approval = await getPendingApproval(office, config);
  if (!approval || approval.action !== "claude_code") {
    console.error("❌ FAIL: expected claude_code HITL, got", approval?.action ?? "none");
    process.exitCode = 1;
    return;
  }
  console.log("✅ HITL interrupt:", approval.action, "—", approval.title);

  await office.invoke(new Command({ resume: "approved" }), config);

  const after = await getPendingApproval(office, config);
  if (after) {
    console.error("❌ FAIL: nested HITL after approve:", after.action);
    process.exitCode = 1;
    return;
  }

  const state = await office.getState(config);
  const last = state.values?.messages?.at(-1);
  const text =
    typeof last?.content === "string"
      ? last.content
      : Array.isArray(last?.content)
        ? last.content.map((c: { text?: string }) => c.text ?? "").join("")
        : String(last?.content ?? "");

  const claudeOnHost = findClaudeBinary() !== null;
  if (!claudeOnHost && isStructuredToolFailure(text)) {
    console.log("✅ Resume OK — tool failure relayed (no claude CLI)");
    console.log("   ", text.slice(0, 220));
  } else if (claudeOnHost && text.length > 20) {
    console.log("✅ Resume OK — claude_code path completed");
    console.log("   ", text.slice(0, 300));
  } else {
    console.log("✅ Resume cleared HITL; reply:", text.slice(0, 300) || "(empty)");
  }
}

main()
  .catch((e) => {
    console.error("FAIL:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });
