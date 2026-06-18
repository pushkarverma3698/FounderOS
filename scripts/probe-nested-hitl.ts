#!/usr/bin/env node
/** Debug nested revenue HITL — what does the graph do on a LinkedIn post request? */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildNestedOffice } from "../src/agents/revenue-domain.js";
import { getPendingApproval } from "../src/agents/office.js";
import { getConfiguredModelId } from "../src/agents/model.js";

const MSG =
  "Post this on LinkedIn: '3 founders asked me about AI agents today. Here is what I told them: start with one painful workflow, automate it end to end, measure the hours saved, then expand.'";

async function main() {
  console.log("model:", getConfiguredModelId());
  const office = buildNestedOffice(new MemorySaver());
  const config = { configurable: { thread_id: `probe-nested-${Date.now()}` } };

  await office.invoke({ messages: [new HumanMessage(MSG)] }, config);

  const approval = await getPendingApproval(office, config);
  const state = await office.getState(config);

  console.log("\n--- approval ---");
  console.log(JSON.stringify(approval, null, 2));

  console.log("\n--- state.next ---", state.next);
  console.log("--- tasks ---", (state.tasks ?? []).length);
  for (const [i, t] of (state.tasks ?? []).entries()) {
    const task = t as { name?: string; interrupts?: unknown[] };
    console.log(`  task[${i}] name=${task.name ?? "?"} interrupts=${task.interrupts?.length ?? 0}`);
  }

  const msgs = (state.values as { messages?: Array<{ _getType?: () => string; content?: unknown; name?: string }> })
    ?.messages ?? [];
  console.log("\n--- message trail (last 8) ---");
  for (const m of msgs.slice(-8)) {
    const type = m._getType?.() ?? "?";
    const content =
      typeof m.content === "string"
        ? m.content.slice(0, 200)
        : JSON.stringify(m.content).slice(0, 200);
    console.log(`  [${type}${m.name ? `/${m.name}` : ""}] ${content}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
