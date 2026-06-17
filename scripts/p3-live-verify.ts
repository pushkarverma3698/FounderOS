/**
 * P3 live verification — handoff isolation + P2 HITL still works on real office path.
 * Run: pnpm verify:p3:live
 */
process.env["ENGINEERING_SUBGRAPH"] = "1";

import { MemorySaver } from "@langchain/langgraph";
import { OFFICE_RECURSION_LIMIT } from "../src/core/config.js";
import {
  engineeringHandoffTokenEstimate,
  ENGINEERING_HANDOFF_TOKEN_CEILING,
  extractEngineeringHandoff,
  isolateEngineeringMessages,
} from "../src/agents/handoff-engineering.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { estimateMessageTokens } from "../src/infra/context-manager.js";

const PROMPT =
  "Create a GitHub issue on pushkarverma3698/FounderOS titled 'P3 live verify' with body 'handoff gate'. Use tools now.";

async function main() {
  // ── 1. Isolation shrinks bloated boundary input ─────────────────────────────
  const handoff = extractEngineeringHandoff(PROMPT);
  const bloat = new SystemMessage(
    "COMPANY_CONTEXT_BLOAT: ".repeat(200) + ` task: ${PROMPT}`,
  );
  const bloatedTokens = estimateMessageTokens([
    bloat,
    new HumanMessage(PROMPT),
    new HumanMessage("unrelated stale history ".repeat(50)),
  ]);
  const isolatedTokens = engineeringHandoffTokenEstimate(handoff);

  console.log(`bloated_input_tokens≈${bloatedTokens}`);
  console.log(`isolated_slice_tokens≈${isolatedTokens} (ceiling ${ENGINEERING_HANDOFF_TOKEN_CEILING})`);

  if (isolatedTokens > ENGINEERING_HANDOFF_TOKEN_CEILING) {
    console.error("FAIL: isolated slice exceeds token ceiling");
    process.exit(1);
  }
  if (isolatedTokens >= bloatedTokens) {
    console.error("FAIL: isolation did not reduce tokens vs bloated input");
    process.exit(1);
  }
  console.log("PASS handoff_isolation_token_shrink");

  const isolated = isolateEngineeringMessages([bloat, new HumanMessage(PROMPT)], handoff);
  const isolatedText = isolated.map((m) => String(m.content)).join("\n");
  if (isolatedText.includes("COMPANY_CONTEXT_BLOAT")) {
    console.error("FAIL: bloat leaked into isolated messages");
    process.exit(1);
  }
  console.log("PASS handoff_isolation_strips_bloat");

  // ── 2. P2 regression — real office still surfaces HITL interrupt ────────────
  const { buildOffice, getPendingApproval } = await import("../src/agents/office.js");
  const { buildOfficeInput } = await import("../src/gateway/pre-router.js");

  const office = buildOffice(new MemorySaver());
  /** Nested CTO subgraph needs headroom beyond prod telegram default (often 20). */
  const liveRecursionLimit = Math.max(OFFICE_RECURSION_LIMIT, 40);
  const config = {
    configurable: { thread_id: `p3-live-${Date.now()}` },
    recursionLimit: liveRecursionLimit,
  };

  console.log("STEP invoke (expect HITL after P3 handoff wiring)...");
  await office.invoke({ messages: buildOfficeInput(PROMPT) }, config);
  const approval = await getPendingApproval(office, config);
  if (!approval) {
    console.error("FAIL: no HITL interrupt after P3 wiring");
    process.exit(1);
  }
  console.log(`PASS hitl_interrupt: action=${approval.action}`);
  console.log("\nP3 live verification passed.");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
