import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildEngineeringDomain } from "../src/agents/engineering-domain.js";
async function main() {
  const cto = buildEngineeringDomain();
  const config = { configurable: { thread_id: "probe-cto" }, recursionLimit: 30 };
  try {
    const res: any = await cto.invoke(
      { messages: [new HumanMessage("List the open branches on repo pushkarverma3698/FounderOS.")] },
      config,
    );
    const msgs = res.messages ?? [];
    console.log("STEPS:", msgs.length);
    for (const m of msgs.slice(-12)) {
      const t = m._getType?.() ?? "?";
      const name = m.name ? `[${m.name}]` : "";
      const calls = (m.tool_calls ?? []).map((c: any) => c.name).join(",");
      const c = typeof m.content === "string" ? m.content.slice(0, 70) : "";
      console.log(`  ${t}${name} ${calls ? "calls="+calls : ""} ${c}`);
    }
  } catch (e: any) {
    console.log("CTO_FAIL:", e?.message?.slice(0, 120));
  }
}
main().then(() => process.exit(0));
