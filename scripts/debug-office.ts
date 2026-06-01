/**
 * Debug harness — runs the office email flow and dumps the message trail +
 * interrupt state, so we can see exactly how an approval surfaces.
 * Mocks the email tool so nothing is actually sent.
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildOffice } from "../src/agents/office.js";

const office = buildOffice(new MemorySaver());
const config = { configurable: { thread_id: "debug-1" } };

const res = await office.invoke(
  { messages: [new HumanMessage("Send an email to test@example.com with subject 'Hello' and body 'Just saying hi.'")] },
  config,
) as Record<string, unknown>;

console.log("=== top-level result keys ===");
console.log(Object.keys(res));
console.log("=== __interrupt__ ===");
console.log(JSON.stringify(res["__interrupt__"], null, 2));

console.log("=== message trail ===");
const msgs = (res["messages"] ?? []) as Array<{ _getType?: () => string; content: unknown; name?: string; tool_calls?: unknown }>;
for (const m of msgs) {
  const type = m._getType?.() ?? "?";
  const tc = m.tool_calls ? ` toolcalls=${JSON.stringify(m.tool_calls)}` : "";
  console.log(`- [${type}]${m.name ? " name=" + m.name : ""} ${String(m.content).slice(0, 120)}${tc}`);
}

console.log("=== getState().next + tasks ===");
const state = await office.getState(config);
console.log("next:", state.next);
console.log("tasks:", JSON.stringify(state.tasks, null, 2));

process.exit(0);
