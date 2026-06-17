/**
 * P2 live verification — real office invoke path with ENGINEERING_SUBGRAPH=1.
 * Proves: pre-router → COS → CTO subgraph → devops → HITL interrupt → approve → tool runs.
 *
 * Run: pnpm verify:p2:live
 * Optional: P2_LIVE_APPROVE=0 to stop at interrupt (no GitHub side effect).
 */
process.env["ENGINEERING_SUBGRAPH"] = "1";

import { MemorySaver, Command } from "@langchain/langgraph";
import { OFFICE_RECURSION_LIMIT } from "../src/core/config.js";

const APPROVE = process.env["P2_LIVE_APPROVE"] !== "0";
/** Nested CTO subgraph needs headroom beyond prod telegram default (often 20). */
const LIVE_RECURSION_LIMIT = Math.max(OFFICE_RECURSION_LIMIT, 40);
const PROMPT =
  "Create a GitHub issue on pushkarverma3698/FounderOS titled 'P2 live verify' with body 'automated gate'. Use tools now.";

async function main() {
  const { buildOffice, getPendingApproval } = await import("../src/agents/office.js");
  const { buildOfficeInput } = await import("../src/gateway/pre-router.js");

  const office = buildOffice(new MemorySaver());
  const config = {
    configurable: { thread_id: `p2-live-${Date.now()}` },
    recursionLimit: LIVE_RECURSION_LIMIT,
  };

  console.log("STEP 1 invoke (expect HITL interrupt)...");
  await office.invoke({ messages: buildOfficeInput(PROMPT) }, config);

  const approval = await getPendingApproval(office, config);
  if (!approval) {
    console.error("FAIL: no pending approval after invoke");
    process.exit(1);
  }
  console.log(`PASS interrupt: action=${approval.action} title=${approval.title}`);

  if (!APPROVE) {
    console.log("PASS (interrupt-only mode, P2_LIVE_APPROVE=0)");
    return;
  }

  console.log("STEP 2 resume approved (expect tool run + completion)...");
  await office.invoke(new Command({ resume: "approved" }), config);

  const after = await getPendingApproval(office, config);
  if (after) {
    console.error("FAIL: still pending after approve:", after.action);
    process.exit(1);
  }

  const state = await office.getState(config);
  const last = state.values?.messages?.at(-1);
  const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content);
  console.log(`PASS approve: last_message=${text.slice(0, 200)}`);
  console.log("\nP2 live verification passed.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
