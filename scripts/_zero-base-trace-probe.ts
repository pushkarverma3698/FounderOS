/**
 * Zero-Base Audit — Phase C: full orchestration trace with a scripted model.
 * The fetch boundary returns deterministic OpenAI-format completions, so the
 * REAL LangGraph supervisor/department/tool machinery executes end-to-end.
 * Measures: LLM hops, prompt bytes per hop, tools offered, message growth.
 */

process.env["DATABASE_URL"] = "postgres://audit:audit@localhost:5432/audit";
process.env["TELEGRAM_BOT_TOKEN"] = "000000:audit-dummy";
process.env["TELEGRAM_CHAT_ID"] = "1";
process.env["LOG_LEVEL"] = "warn";
process.env["OPENROUTER_API_KEY"] = "sk-or-scripted";

interface HopLog {
  n: number;
  bytes: number;
  nMessages: number;
  nTools: number;
  toolNames: string[];
  lastMsgRole: string;
  respondedWith: string;
}
const hops: HopLog[] = [];

// Per-agent scripted behaviour, keyed by the tool surface of the request.
let agentToolCallsDone = new Set<string>();

function scriptResponse(body: any): any {
  const tools: string[] = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
  const isSupervisor = tools.some((t) => t.startsWith("transfer_to_"));
  const msgs = body.messages ?? [];
  const lastRole = msgs[msgs.length - 1]?.role ?? "?";

  let message: any;
  let label: string;
  if (isSupervisor) {
    const alreadyTransferred = msgs.some(
      (m: any) => m.role === "tool" || (m.tool_calls ?? []).length > 0 ||
        (typeof m.content === "string" && m.content.includes("transfer_back")),
    );
    if (!alreadyTransferred) {
      label = "tool_call transfer_to_research";
      message = {
        role: "assistant", content: "",
        tool_calls: [{ id: "call_sup_1", type: "function", function: { name: "transfer_to_research", arguments: "{}" } }],
      };
    } else {
      label = "final answer";
      message = { role: "assistant", content: "LangGraph released v1.4 — details from research." };
    }
  } else {
    // department agent (research): first call search_web, then answer
    if (!agentToolCallsDone.has("research")) {
      agentToolCallsDone.add("research");
      label = "tool_call search_web";
      message = {
        role: "assistant", content: "",
        tool_calls: [{ id: "call_res_1", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: "LangGraph latest news" }) } }],
      };
    } else {
      label = "dept final answer";
      message = { role: "assistant", content: "Research summary: LangGraph v1.4 released." };
    }
  }

  hops.push({
    n: hops.length + 1,
    bytes: JSON.stringify(body).length,
    nMessages: msgs.length,
    nTools: tools.length,
    toolNames: tools,
    lastMsgRole: lastRole,
    respondedWith: label,
  });

  return {
    id: `chatcmpl-audit-${hops.length}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: Math.round(hops[hops.length - 1]!.bytes / 4), completion_tokens: 20, total_tokens: 0 },
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  if (url.includes("openrouter.ai")) {
    const body = JSON.parse(init?.body ?? "{}");
    const resp = scriptResponse(body);
    return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" } });
  }
  process.stderr.write(`[real fetch] → ${url}\n`);
  return realFetch(input, init);
}) as typeof fetch;

const t0 = Date.now();
const step = (s: string) => process.stderr.write(`[+${Date.now() - t0}ms] ${s}\n`);

async function main() {
  const { MemorySaver } = await import("@langchain/langgraph");
  const { buildOffice } = await import("../src/agents/office.js");
  const { buildOfficeInput } = await import("../src/gateway/pre-router.js");

  const office = buildOffice(new MemorySaver());
  step("graph compiled");

  const text = "Research the latest news about LangGraph.";
  const input = buildOfficeInput(text);
  step(`pre-router emitted ${input.length} messages:`);
  for (const m of input) {
    const c = typeof (m as any).content === "string" ? (m as any).content : JSON.stringify((m as any).content);
    step(`  [${(m as any)._getType()}] (${c.length} chars) ${c.slice(0, 160).replace(/\n/g, " ")}`);
  }

  step("invoking…");
  const res = await office.invoke(
    { messages: input },
    { configurable: { thread_id: "audit-trace" }, recursionLimit: 25 },
  );
  step("invoke returned OK");
  const msgs = (res as any).messages ?? [];
  step(`state now holds ${msgs.length} messages`);
  for (const m of msgs) {
    const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const tc = (m.tool_calls ?? []).map((t: any) => t.name).join(",");
    step(`  [${m._getType?.()}${m.name ? ":" + m.name : ""}]${tc ? ` tools=[${tc}]` : ""} ${c.slice(0, 120).replace(/\n/g, " ")}`);
  }

  console.log("\n══ LLM HOP TABLE ══");
  for (const h of hops) {
    console.log(
      `hop ${h.n}: ${h.bytes.toLocaleString()} bytes, ${h.nMessages} msgs, ${h.nTools} tools [${h.toolNames.slice(0, 8).join(", ")}${h.nTools > 8 ? ", …" : ""}], last=${h.lastMsgRole} → ${h.respondedWith}`,
    );
  }
  console.log(`TOTAL: ${hops.length} LLM calls, ${hops.reduce((a, b) => a + b.bytes, 0).toLocaleString()} bytes uploaded, for ONE trivial task`);
}

main().catch((err) => {
  step(`FAILED after ${hops.length} LLM hops`);
  console.error("ERROR:", err?.message);
  console.error(err?.stack?.split("\n").slice(0, 20).join("\n"));
  console.log("\n══ LLM HOP TABLE (at failure) ══");
  for (const h of hops) {
    console.log(`hop ${h.n}: ${h.bytes} bytes, ${h.nMessages} msgs, ${h.nTools} tools, → ${h.respondedWith}`);
  }
  process.exit(1);
});
