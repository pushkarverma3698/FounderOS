/**
 * Zero-Base Audit — "Hello World" of the agentic loop.
 * Compiles the REAL office graph (MemorySaver, same seam as tests/integration)
 * and invokes exactly one message. Instruments fetch to trace every outbound
 * model call. No mocks on the orchestration path.
 */

// Minimal env to satisfy the Zod boot schema (config.ts parses at import time)
process.env["DATABASE_URL"] = "postgres://audit:audit@localhost:5432/audit";
process.env["TELEGRAM_BOT_TOKEN"] = "000000:audit-dummy";
process.env["TELEGRAM_CHAT_ID"] = "1";
process.env["LOG_LEVEL"] = "warn";

const PHASE = process.env["PROBE_PHASE"] ?? "A";
if (PHASE === "B") {
  // Fake key: graph compiles, model call fails at the provider boundary — the
  // trace shows how the orchestration handles a failing LLM node.
  process.env["OPENROUTER_API_KEY"] = "sk-or-v1-deliberately-invalid-audit-key";
}

// ── fetch instrumentation: log every outbound call the graph makes ──────────
const realFetch = globalThis.fetch;
let callN = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input?.url ?? String(input);
  const n = ++callN;
  const t0 = Date.now();
  process.stderr.write(`[fetch #${n}] → ${url}\n`);
  try {
    const res = await realFetch(input, init);
    process.stderr.write(`[fetch #${n}] ← ${res.status} ${res.statusText} (${Date.now() - t0}ms)\n`);
    return res;
  } catch (e: any) {
    process.stderr.write(`[fetch #${n}] ✗ ${e?.message} (${Date.now() - t0}ms)\n`);
    throw e;
  }
}) as typeof fetch;

const t0 = Date.now();
const step = (s: string) => process.stderr.write(`[+${Date.now() - t0}ms] ${s}\n`);

async function main() {
  step("importing office module graph…");
  const { MemorySaver } = await import("@langchain/langgraph");
  const { HumanMessage } = await import("@langchain/core/messages");
  const { buildOffice } = await import("../src/agents/office.js");
  const { buildOfficeInput } = await import("../src/gateway/pre-router.js");
  step("imports done");

  step("compiling office graph (buildOffice + MemorySaver)…");
  const office = buildOffice(new MemorySaver());
  step("graph compiled");

  const text = "Hello! Please just reply with the word 'hello'.";
  const input = buildOfficeInput(text);
  step(`pre-router produced ${input.length} message(s): ${input.map((m: any) => m._getType()).join(", ")}`);
  for (const m of input) {
    const c = typeof (m as any).content === "string" ? (m as any).content : JSON.stringify((m as any).content);
    step(`  [${(m as any)._getType()}] ${c.slice(0, 200)}`);
  }

  step("invoking office…");
  const res = await office.invoke(
    { messages: input.length ? input : [new HumanMessage(text)] },
    { configurable: { thread_id: "audit-hello" }, recursionLimit: 25 },
  );
  step("invoke returned");
  const msgs = (res as any).messages ?? [];
  step(`final message count: ${msgs.length}`);
  const last = msgs[msgs.length - 1];
  step(`last message [${last?._getType?.()}]: ${String(last?.content).slice(0, 300)}`);
}

main().catch((err) => {
  step("─".repeat(60));
  step(`FAILED after ${callN} model call(s)`);
  console.error("ERROR NAME:", err?.name);
  console.error("ERROR MESSAGE:", err?.message);
  console.error("STACK:\n", err?.stack?.split("\n").slice(0, 25).join("\n"));
  if (err?.cause) console.error("CAUSE:", err.cause?.message ?? err.cause);
  process.exit(1);
});
