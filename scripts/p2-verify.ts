/**
 * P2 verification — engineering subgraph wired into the live office topology.
 * Run: pnpm verify:p2  (sets ENGINEERING_SUBGRAPH=1)
 *
 * Deterministic structural checks only (no LLM). Complements beta-verify.ts
 * which asserts subgraph flags default OFF.
 */
process.env["ENGINEERING_SUBGRAPH"] = "1";

async function main() {
  const { buildOffice } = await import("../src/agents/office.js");
  const { buildEngineeringDomain } = await import("../src/agents/engineering-domain.js");
  const { ENGINEERING_SUBGRAPH_ENABLED } = await import("../src/core/config.js");
  const { ENGINEERING_SUBAGENT_TOOLS } = await import("../src/agents/capabilities.js");
  const { preRouteDepartment } = await import("../src/gateway/pre-router.js");
  const { MemorySaver } = await import("@langchain/langgraph");

  function officeNodes(office: ReturnType<typeof buildOffice>): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = office as any;
    return Object.keys(g.builder?.nodes ?? g.nodes ?? {});
  }

  const office = buildOffice(new MemorySaver());
  const nodes = officeNodes(office).sort();
  const cto = buildEngineeringDomain();

  const toolNames = (k: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ENGINEERING_SUBAGENT_TOOLS[k] ?? []).map((t: any) => t.name).sort();

  const githubIssuePrompt =
    "Create a GitHub issue on pushkarverma3698/FounderOS titled 'P2 verify' with body 'structural gate'.";

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "engineering_subgraph_flag_on",
      ok: ENGINEERING_SUBGRAPH_ENABLED === true,
      detail: String(ENGINEERING_SUBGRAPH_ENABLED),
    },
    {
      name: "office_compiles_with_subgraph",
      ok: typeof office.invoke === "function",
      detail: `${nodes.length} nodes`,
    },
    {
      name: "engineering_node_present",
      ok: nodes.includes("engineering"),
      detail: nodes.join(", "),
    },
    {
      name: "all_departments_routable",
      ok: ["admin", "research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"].every(
        (d) => nodes.includes(d),
      ),
      detail: nodes.join(", "),
    },
    {
      name: "cto_subgraph_compiles",
      ok: typeof cto.invoke === "function",
      detail: "invoke ok",
    },
    {
      name: "cto_subagent_toolsets",
      ok:
        toolNames("coder").join() === "claude_code,github_read" &&
        toolNames("qa").join() === "claude_code,github_read" &&
        toolNames("devops").join() === "github_write,project_workflow",
      detail: `coder=[${toolNames("coder")}] devops=[${toolNames("devops")}]`,
    },
    {
      name: "pre_router_github_issue_to_engineering",
      ok: preRouteDepartment(githubIssuePrompt) === "engineering",
      detail: String(preRouteDepartment(githubIssuePrompt)),
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
  console.log("\nAll P2 engineering subgraph structural checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
