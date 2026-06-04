/**
 * Probe: run REAL tasks through a FRESH office (MemorySaver) and dump the full
 * message trail + every tool call. Reveals whether the supervisor relays
 * sub-agent results or goes generic, and whether it loops.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/probe-real-task.ts
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { buildOffice } from "../src/agents/office.js";
import { markdownToTelegramHtml } from "../src/gateway/format.js";

/** Validate that rendered HTML uses only Telegram-allowed tags, balanced, no leaked markdown. */
function validateTelegramHtml(html: string): string[] {
  const ALLOWED = ["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"];
  const issues: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z-]+)(?:\s[^>]*)?>/g)) {
    const close = m[1];
    const name = m[2] ?? "";
    if (!ALLOWED.includes(name)) { issues.push(`disallowed <${name}>`); continue; }
    if (close) { if (stack[stack.length - 1] === name) stack.pop(); else issues.push(`unbalanced </${name}>`); }
    else stack.push(name);
  }
  if (stack.length) issues.push(`unclosed <${stack.join(",")}>`);
  if (/<b>\s*<b>|<i>\s*<i>/.test(html)) issues.push("nested identical tags (Telegram 400)");
  if (/\*\*|^\s*#{1,6}\s|^\|.*\|.*\n\|\s*-/m.test(html)) issues.push("leaked markdown");
  return issues;
}

const tasks = process.argv.slice(2);
const TASKS = tasks.length > 0 ? tasks : [
  "hi",
  "what is the capital of France?",
  "list the files on my Desktop",
];

async function main() {
  // --thread mode: reuse ONE office + ONE thread across all tasks (simulates the
  // real Telegram accumulation that caused the looping bug).
  const sharedThread = process.env["PROBE_SHARED_THREAD"] === "1";
  const sharedOffice = sharedThread ? buildOffice(new MemorySaver()) : null;
  const sharedThreadId = `probe:shared:${Math.random().toString(36).slice(2)}`;

  for (const task of TASKS) {
    const office = sharedOffice ?? buildOffice(new MemorySaver());
    const threadId = sharedThread ? sharedThreadId : `probe:${Math.random().toString(36).slice(2)}`;
    const config = { configurable: { thread_id: threadId }, recursionLimit: 20 };
    const toolCalls: string[] = [];

    console.log("\n" + "=".repeat(70));
    console.log("TASK:", task);
    console.log("=".repeat(70));

    const res = await office.invoke(
      { messages: [new HumanMessage(task)] },
      {
        ...config,
        recursionLimit: 30,
        callbacks: [{
          handleToolStart(tool: unknown, input: string) {
            const name = (tool as { name?: string })?.name ?? "?";
            toolCalls.push(name);
            console.log(`   🔧 TOOL: ${name}(${String(input).slice(0, 80)})`);
          },
        }],
      },
    ) as { messages?: Array<{ _getType?: () => string; content?: unknown; tool_calls?: unknown[] }> };

    const msgs = res.messages ?? [];
    console.log(`\n   --- trail (${msgs.length} msgs, tools: [${toolCalls.join(", ")}]) ---`);
    for (const m of msgs) {
      const type = m._getType?.() ?? "?";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const tc = m.tool_calls && m.tool_calls.length > 0 ? ` [tool_calls: ${m.tool_calls.length}]` : "";
      console.log(`   [${type}]${tc} ${content.slice(0, 160).replace(/\n/g, " ")}`);
    }
    const lastAi = [...msgs].reverse().find((m) => (m._getType?.() ?? "") === "ai" && typeof m.content === "string" && m.content.trim() && !(m.tool_calls && m.tool_calls.length));
    const reply = typeof lastAi?.content === "string" ? lastAi.content : "(none)";
    console.log(`\n   ✅ FINAL REPLY: ${reply.slice(0, 300)}`);
    // Render through the ACTUAL Telegram formatter and validate it.
    const html = markdownToTelegramHtml(reply);
    const fmtIssues = validateTelegramHtml(html);
    console.log(`   🎨 FORMAT: ${fmtIssues.length === 0 ? "✓ valid Telegram HTML" : "❌ " + fmtIssues.join("; ")}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
