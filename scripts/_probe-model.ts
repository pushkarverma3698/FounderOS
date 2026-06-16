import { getModel } from "../src/agents/model.js";
import { HumanMessage } from "@langchain/core/messages";
async function main() {
  const t0 = Date.now();
  const m = getModel();
  const r = await m.invoke([new HumanMessage("Reply with just the number 4. What is 2+2?")]);
  const c = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
  console.log("MODEL_OK", Date.now() - t0, "ms ->", c.slice(0, 40));
}
main().then(() => process.exit(0)).catch((e) => { console.error("MODEL_FAIL", e?.message ?? e); process.exit(1); });
