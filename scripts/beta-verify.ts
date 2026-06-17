/**
 * Beta verification smoke — compile office, check hierarchy invariants.
 * Run: node --env-file=.env --import tsx/esm scripts/beta-verify.ts
 */
import { buildOffice } from "../src/agents/office.js";
import { MemorySaver } from "@langchain/langgraph";
import { SUPERVISOR_TOOLS, DEPARTMENT_TOOLS } from "../src/agents/capabilities.js";
import { preRouteDepartment } from "../src/gateway/pre-router.js";
import { detectTaskLedger } from "../src/gateway/task-ledger.js";
import { ENGINEERING_SUBGRAPH_ENABLED, REVENUE_SUBGRAPH_ENABLED } from "../src/core/config.js";

function officeNodes(office: ReturnType<typeof buildOffice>): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = office as any;
  return Object.keys(g.builder?.nodes ?? g.nodes ?? {});
}

const office = buildOffice(new MemorySaver());
const nodes = officeNodes(office).sort();

const checks: Array<{ name: string; ok: boolean; detail: string }> = [
  {
    name: "supervisor_no_tools",
    ok: SUPERVISOR_TOOLS.length === 0,
    detail: `SUPERVISOR_TOOLS.length=${SUPERVISOR_TOOLS.length}`,
  },
  {
    name: "admin_department_present",
    ok: nodes.includes("admin"),
    detail: nodes.join(", "),
  },
  {
    name: "admin_has_context_tools",
    ok: (DEPARTMENT_TOOLS["admin"] ?? []).some((t: { name: string }) => t.name === "read_context"),
    detail: (DEPARTMENT_TOOLS["admin"] ?? []).map((t: { name: string }) => t.name).join(", "),
  },
  {
    name: "pre_router_admin_focus",
    ok: preRouteDepartment("What's my current focus and priorities?") === "admin",
    detail: String(preRouteDepartment("What's my current focus and priorities?")),
  },
  {
    name: "task_ledger_monday_brief",
    ok: (detectTaskLedger("monday brief: context memory + github issues + plan") ?? [])
      .map((s) => s.dept)
      .join(",") === "admin,engineering,synthesize",
    detail: (detectTaskLedger("monday brief: context memory + github issues + plan") ?? [])
      .map((s) => s.dept)
      .join(" -> "),
  },
  {
    name: "revenue_subgraph_flag_off_by_default",
    ok: REVENUE_SUBGRAPH_ENABLED === false,
    detail: String(REVENUE_SUBGRAPH_ENABLED),
  },
  {
    name: "engineering_subgraph_flag_off_by_default",
    ok: ENGINEERING_SUBGRAPH_ENABLED === false,
    detail: String(ENGINEERING_SUBGRAPH_ENABLED),
  },
];

let failed = 0;
for (const c of checks) {
  const mark = c.ok ? "PASS" : "FAIL";
  if (!c.ok) failed++;
  console.log(`${mark} ${c.name}: ${c.detail}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll beta hierarchy smoke checks passed.");
