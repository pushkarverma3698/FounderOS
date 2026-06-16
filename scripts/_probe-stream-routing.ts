/**
 * Stream-based routing probe — intercepts the first transfer_to_* event
 * from the CTO before the worker runs. Stops immediately after routing.
 * This avoids HITL interrupt() loops in the standalone (no-checkpointer) context.
 */
import { HumanMessage } from "@langchain/core/messages";
import { buildEngineeringDomain } from "../src/agents/engineering-domain.js";

type RouteResult = { label: string; route: string; expected: string; ok: boolean };

async function probeRoute(label: string, task: string, expected: string): Promise<RouteResult> {
  const cto = buildEngineeringDomain();
  const cfg = { configurable: { thread_id: `stream-${Date.now()}-${Math.random()}` }, recursionLimit: 30 };

  const stream = await cto.streamEvents({ messages: [new HumanMessage(task)] }, { ...cfg, version: "v2" });

  for await (const event of stream) {
    // Accept any LLM call that emits a transfer_to_* — the node name varies by model provider
    if (event.event === "on_chat_model_end") {
      const output = event.data?.output;
      const toolCalls: any[] = output?.tool_calls ?? output?.additional_kwargs?.tool_calls ?? [];
      for (const tc of toolCalls) {
        const tcName: string = tc.name ?? tc.function?.name ?? "";
        if (tcName.startsWith("transfer_to_")) {
          const agent = tcName.replace("transfer_to_", "");
          stream.return?.();
          const ok = agent === expected;
          return { label, route: agent, expected, ok };
        }
      }
    }
  }

  return { label, route: "NO_TRANSFER", expected, ok: false };
}

async function main() {
  const cases: [string, string, string][] = [
    ["READ→coder",   "List the open branches on repo pushkarverma3698/FounderOS.", "coder"],
    ["INSPECT→coder","Show the latest commit on the main branch of pushkarverma3698/FounderOS.", "coder"],
    ["CODE→coder",   "Write a TypeScript function that returns the square of a number.", "coder"],
    ["VERIFY→qa",    "Review src/agents/engineering-domain.ts for bugs.", "qa"],
    ["WRITE→devops", "Create a GitHub issue titled 'routing probe' on pushkarverma3698/FounderOS.", "devops"],
    ["PR→devops",    "Open a pull request from feat/test to main on pushkarverma3698/FounderOS.", "devops"],
  ];

  let pass = 0, fail = 0;
  for (const [label, task, expected] of cases) {
    const r = await probeRoute(label, task, expected);
    const icon = r.ok ? "✅" : "❌";
    console.log(`${icon} [${r.label}] → ${r.route} (expected: ${r.expected})`);
    if (r.ok) pass++; else fail++;
  }
  console.log(`\nROUTING: ${pass}/${cases.length} correct`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
