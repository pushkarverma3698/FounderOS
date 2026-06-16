import { HumanMessage } from "@langchain/core/messages";
import { buildEngineeringDomain } from "../src/agents/engineering-domain.js";

async function main() {
  const cto = buildEngineeringDomain();
  const cfg = { configurable: { thread_id: `debug-${Date.now()}` }, recursionLimit: 12 };
  const stream = await cto.streamEvents(
    { messages: [new HumanMessage("List the open branches on repo pushkarverma3698/FounderOS.")] },
    { ...cfg, version: "v2" }
  );
  let count = 0;
  for await (const event of stream) {
    if (event.event === "on_chat_model_end") {
      const out = event.data?.output;
      const calls: any[] = out?.tool_calls ?? out?.additional_kwargs?.tool_calls ?? [];
      console.log(`[${count}] on_chat_model_end  name=${event.name}  tags=${JSON.stringify(event.tags?.slice(0, 4))}  tool_calls=${calls.map((c: any) => c.name ?? c.function?.name).join(",") || "(none)"}`);
      count++;
      if (count >= 4) break;
    }
  }
  console.log("done");
}
main();
