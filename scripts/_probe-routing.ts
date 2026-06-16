/**
 * Routing-only probe — checks WHICH agent the CTO transfers to, then stops.
 * Does NOT wait for tools to complete (avoids HITL hang on github_write).
 */
import { HumanMessage } from "@langchain/core/messages";
import { buildEngineeringDomain } from "../src/agents/engineering-domain.js";

type RouteResult = { task: string; route: string; ok: boolean };

function extractTransfer(msgs: any[]): string | null {
  for (const m of msgs) {
    if (m._getType?.() === "ai" && m.name === "engineering") {
      const calls: string[] = (m.tool_calls ?? []).map((c: any) => c.name as string);
      const transfer = calls.find((n) => n.startsWith("transfer_to_"));
      if (transfer) return transfer.replace("transfer_to_", "");
    }
  }
  return null;
}

async function probe(task: string): Promise<RouteResult> {
  const cto = buildEngineeringDomain();
  // 25 gives nested graph enough budget (CTO + worker each need ~5-10 steps)
  const cfg = { configurable: { thread_id: `routing-${Date.now()}` }, recursionLimit: 25 };
  try {
    const res: any = await cto.invoke({ messages: [new HumanMessage(task)] }, cfg);
    const msgs: any[] = res.messages ?? [];
    const transfer = extractTransfer(msgs);
    if (transfer) return { task, route: transfer, ok: true };
    return { task, route: "NO_TRANSFER", ok: false };
  } catch (e: any) {
    const msg: string = e?.message ?? "";
    // NodeInterrupt = HITL fired (devops triggered github_write) — correct routing
    if (msg.includes("NodeInterrupt") || msg.includes("interrupt")) {
      return { task, route: "devops(HITL)", ok: true };
    }
    // Recursion limit: graph ran but exceeded budget — extract routing from partial state
    if (msg.includes("Recursion limit") || msg.includes("recursion")) {
      const partial: any[] = (e as any)?.state?.messages ?? [];
      const transfer = extractTransfer(partial);
      if (transfer) return { task, route: `${transfer}(budget)`, ok: true };
      return { task, route: `ERR(budget): no transfer found`, ok: false };
    }
    return { task, route: `ERR: ${msg.slice(0, 80)}`, ok: false };
  }
}

async function main() {
  const cases: [string, string, string][] = [
    ["READ→coder",  "List the open branches on repo pushkarverma3698/FounderOS.", "coder"],
    ["INSPECT→coder","Show the latest commit on the main branch of pushkarverma3698/FounderOS.", "coder"],
    ["CODE→coder",  "Write a TypeScript function that returns the square of a number.", "coder"],
    ["VERIFY→qa",   "Review src/agents/engineering-domain.ts for bugs.", "qa"],
    ["WRITE→devops","Create a GitHub issue titled 'routing probe' on pushkarverma3698/FounderOS.", "devops"],
    ["PR→devops",   "Open a pull request from feat/test to main on pushkarverma3698/FounderOS.", "devops"],
  ];

  let pass = 0;
  let fail = 0;
  for (const [label, task, expected] of cases) {
    const r = await probe(task);
    const actual = r.route.replace("(HITL)", "").replace("(budget)", "");
    const ok = r.ok && actual === expected;
    const icon = ok ? "✅" : "❌";
    console.log(`${icon} [${label}] → ${r.route} (expected: ${expected})`);
    if (ok) pass++; else fail++;
  }
  console.log(`\nROUTING: ${pass}/${cases.length} correct`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
