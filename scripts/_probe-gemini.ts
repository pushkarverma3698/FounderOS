import { ChatVertexAI } from "@langchain/google-vertexai";
import { HumanMessage } from "@langchain/core/messages";
async function main() {
  const key = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
  console.log("key_len:", key.length, "prefix_ok:", key.startsWith("AIza"));
  const m = new ChatVertexAI({ model: "gemini-2.5-flash", temperature: 0, apiKey: key });
  const t0 = Date.now();
  try {
    const r = await m.invoke([new HumanMessage("Say 4")]);
    console.log("GEMINI_OK", Date.now() - t0, "ms", typeof r.content === "string" ? r.content : "");
  } catch (e: any) {
    console.log("GEMINI_FAIL", Date.now() - t0, "ms", "status=", e?.status ?? e?.response?.status, "msg=", (e?.message ?? "").slice(0, 200));
  }
}
main().then(() => process.exit(0));
