/**
 * Probe: verify a build task routes engineering → claude_code with ONE HITL
 * approval containing the complete task brief (the engine-swap contract).
 * Run: node --env-file=.env --import tsx/esm scripts/probe-executor-routing.ts
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildOffice, getPendingApproval } from "../src/agents/office.js";

async function main() {
  const office = buildOffice(new MemorySaver());
  const config = { configurable: { thread_id: "probe-executor" }, recursionLimit: 40 };
  await office.invoke(
    { messages: [new HumanMessage("Make a basic test website and push it to git as a new repo")] },
    config,
  );
  const approval = await getPendingApproval(office, config);
  if (!approval) {
    console.log("❌ NO APPROVAL FIRED — task completed or failed without HITL");
    process.exit(1);
  }
  console.log("APPROVAL ACTION:", (approval as { action?: string }).action);
  console.log("APPROVAL TITLE:", (approval as { title?: string }).title);
  console.log("APPROVAL PREVIEW:\n", String((approval as { preview?: string }).preview).slice(0, 600));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
