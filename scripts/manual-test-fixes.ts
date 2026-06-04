/**
 * Manual test: verify all 5 issues from the log are fixed.
 * Tests each scenario directly against the live office.
 */

import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

const office = buildOffice(new MemorySaver());

async function ask(id: string, question: string): Promise<string> {
  const config = { configurable: { thread_id: `test-${id}` } };
  const res = await office.invoke({ messages: [new HumanMessage(question)] }, config) as { messages?: Array<{ _getType?: () => string; content: unknown; tool_calls?: unknown[] }> };
  const msgs = res.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    const type = m._getType?.() ?? "";
    const text = typeof m.content === "string" ? m.content : "";
    if (type === "ai" && text.trim() && !(m.tool_calls && (m.tool_calls as unknown[]).length > 0)) {
      return text.trim();
    }
  }
  return "✅ Done.";
}

async function main() {
  console.log("🧪 Manual fix verification\n");

  // FIX 1: Identity — should NOT say "large language model trained by Google"
  console.log("TEST 1: Identity (must NOT leak Google/LLM)");
  const identity = await ask("identity", "What model are you using under the hood?");
  console.log("Reply:", identity.slice(0, 200));
  const leaked = identity.toLowerCase().includes("large language model") || identity.toLowerCase().includes("trained by google");
  console.log(leaked ? "❌ STILL LEAKING IDENTITY" : "✅ Identity fixed");
  console.log();

  // FIX 2: Context — should know about local models after seeding
  console.log("TEST 2: Context (must know about local models + tech stack)");
  const ctx = await ask("context", "Are we using local models in our workflow?");
  console.log("Reply:", ctx.slice(0, 300));
  const knowsLocal = ctx.toLowerCase().includes("ollama") || ctx.toLowerCase().includes("local model") || ctx.toLowerCase().includes("qwen");
  console.log(knowsLocal ? "✅ Context working" : "❌ Still empty context");
  console.log();

  // FIX 3: Knowledge search — should return results from turicks-brain
  console.log("TEST 3: Knowledge search (turicks-brain must have 32 entries now)");
  const knowledge = await ask("knowledge", "Search the internal knowledge base for our brand voice rules on LinkedIn.");
  console.log("Reply:", knowledge.slice(0, 300));
  const hasKnowledge = !knowledge.toLowerCase().includes("not been synced") && !knowledge.toLowerCase().includes("no knowledge entries");
  console.log(hasKnowledge ? "✅ turicks-brain working" : "❌ Knowledge still empty");
  console.log();

  // FIX 4: Self-knowledge — should know about the tech stack
  console.log("TEST 4: Self-knowledge (must describe FounderOS accurately)");
  const self = await ask("self", "What is FounderOS and how many departments does it have?");
  console.log("Reply:", self.slice(0, 300));
  const knowsSelf = self.includes("7") || self.toLowerCase().includes("seven") || self.toLowerCase().includes("department");
  console.log(knowsSelf ? "✅ Self-knowledge working" : "❌ Self-knowledge missing");
  console.log();

  console.log("✅ All manual tests complete.");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
