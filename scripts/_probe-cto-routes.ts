/**
 * Probes all 3 CTO routing paths: coder (read), devops (write), qa (test).
 * Uses OpenRouter fallback when Gemini credits are depleted.
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildEngineeringDomain } from "../src/agents/engineering-domain.js";

async function runProbe(label: string, task: string, threadId: string) {
  const cto = buildEngineeringDomain();
  const config = { configurable: { thread_id: threadId }, recursionLimit: 30 };
  console.log(`\n=== PROBE: ${label} ===`);
  console.log(`Task: ${task}`);
  try {
    const res: any = await cto.invoke({ messages: [new HumanMessage(task)] }, config);
    const msgs = res.messages ?? [];
    for (const m of msgs) {
      const t = m._getType?.() ?? "?";
      const name = m.name ? `[${m.name}]` : "";
      const calls = (m.tool_calls ?? []).map((c: any) => c.name).join(",");
      const c = typeof m.content === "string" ? m.content.slice(0, 100) : "";
      if (t !== "human") console.log(`  ${t}${name} ${calls ? "calls="+calls : ""} ${c}`);
    }
  } catch (e: any) {
    console.log(`  FAIL: ${e?.message?.slice(0, 150)}`);
  }
}

async function main() {
  // Probe 1: Read → should go to coder
  await runProbe(
    "READ→coder",
    "List the open branches on repo pushkarverma3698/FounderOS.",
    "probe-read"
  );

  // Probe 2: Write → should go to devops
  await runProbe(
    "WRITE→devops",
    "Create a GitHub issue titled 'Test accountability probe' on pushkarverma3698/FounderOS.",
    "probe-write"
  );

  // Probe 3: Test/verify → should go to qa
  await runProbe(
    "VERIFY→qa",
    "Review the code in src/agents/engineering-domain.ts and tell me if there are any bugs.",
    "probe-qa"
  );

  // Probe 4: Code generation → should go to coder
  await runProbe(
    "CODE→coder",
    "Write a TypeScript function that returns the square of a number.",
    "probe-code"
  );
}

main().then(() => process.exit(0));
