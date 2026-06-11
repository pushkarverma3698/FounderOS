/**
 * Probe: inspect a LIVE persisted thread's checkpoint state to diagnose the
 * "every message loops to recursion limit" wedge. Read-only — dumps the message
 * trail shapes the supervisor actually sees.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/probe-wedged-thread.ts <chatId>
 */
import { getOffice } from "../src/agents/office.js";
import { TENANT } from "../src/core/config.js";

async function main() {
  const chatId = process.argv[2] ?? "6775330211";
  const threadId = `${TENANT}:${chatId}`;
  const office = await getOffice();
  const config = { configurable: { thread_id: threadId } };

  const state = (await office.getState(config)) as {
    values?: { messages?: Array<{ _getType?: () => string; content?: unknown; tool_calls?: unknown[] }> };
    next?: string[];
    tasks?: unknown[];
  };

  const msgs = state.values?.messages ?? [];
  console.log(`\n=== Thread ${threadId} ===`);
  console.log(`next (pending nodes): ${JSON.stringify(state.next ?? [])}`);
  console.log(`pending tasks: ${(state.tasks ?? []).length}`);
  console.log(`message count: ${msgs.length}\n`);

  msgs.forEach((m, i) => {
    const type = typeof m._getType === "function" ? m._getType() : "?";
    const calls = (m as { tool_calls?: unknown[] }).tool_calls?.length ?? 0;
    const len = typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
    const preview = typeof m.content === "string" ? m.content.slice(0, 80).replace(/\n/g, " ") : "[non-string]";
    console.log(`  [${i}] ${type}${calls ? `+${calls}calls` : ""} len=${len}  ${preview}`);
  });
  console.log("");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
