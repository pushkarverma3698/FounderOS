/**
 * v3 proof renderers — the marketing evidence must be faithful to state.
 */

import { describe, it, expect } from "vitest";
import { renderScoreboard, renderCostLedger, renderCaseStudy } from "../../../src/proof/render.js";
import { KERNEL_SCHEMA_VERSION, type Mission, type StepResult } from "../../../src/kernel/contracts.js";

describe("renderScoreboard", () => {
  const base = {
    generatedAt: "2026-07-08T00:00:00Z",
    commit: "abc1234",
    suite: { files: 120, tests: 1210, failed: 0 },
    kernelScenarios: ["loops terminate with typed failures"],
    archBaseline: { "regex-routing": 0, "fail-open-catch": 11 },
  };

  it("shows green suite + zero-debt checkmarks", () => {
    const md = renderScoreboard(base);
    expect(md).toContain("✅ 1210 tests / 120 files — all green");
    expect(md).toContain("| regex-routing | 0 ✅ |");
    expect(md).toContain("| fail-open-catch | 11 |");
  });

  it("a failing suite renders as FAILING — never silently green", () => {
    const md = renderScoreboard({ ...base, suite: { ...base.suite, failed: 3 } });
    expect(md).toContain("❌ 3 of 1210 tests FAILING");
  });
});

describe("renderCostLedger", () => {
  it("totals rows and renders the table", () => {
    const md = renderCostLedger(
      [
        { day: "2026-07-07", model: "gemini-2.5-flash", calls: 40, inputTokens: 120_000, outputTokens: 8_000, usd: 0.05 },
        { day: "2026-07-08", model: "gemini-2.5-flash", calls: 12, inputTokens: 30_000, outputTokens: 2_000, usd: 0.013 },
      ],
      5,
    );
    expect(md).toContain("Total (window): **$0.06**");
    expect(md).toContain("| 2026-07-07 | gemini-2.5-flash | 40 |");
  });
});

describe("renderCaseStudy", () => {
  const mission: Mission = {
    goal: "Email sam@client.com the LangGraph research summary",
    status: "done",
    cursor: 2,
    plan: {
      schema_version: KERNEL_SCHEMA_VERSION,
      goal: "Email sam@client.com the LangGraph research summary",
      steps: [
        {
          step_id: "s1",
          worker: "research",
          objective: "Research LangGraph",
          inputs: {},
          expected: { kind: "data", schema_ref: "research.findings" },
          constraints: { max_tool_calls: 2, hitl_required: false },
        },
        {
          step_id: "s2",
          worker: "comms",
          objective: "Send summary to sam@client.com",
          inputs: { findings: "s1" },
          expected: { kind: "action_receipt", schema_ref: "action.summary" },
          constraints: { max_tool_calls: 1, hitl_required: true },
        },
      ],
    },
  };
  const results: StepResult[] = [
    { status: "ok", step_id: "s1", output: { summary: "v1.4 shipped", sources: [] }, tool_receipts: [] },
    {
      status: "ok",
      step_id: "s2",
      output: { summary: "sent" },
      tool_receipts: [
        { tool: "send_email", args_hash: "a".repeat(64), result_digest: "b".repeat(64), ok: true, at: "2026-07-08T00:00:00Z" },
      ],
    },
  ];

  it("anonymizes emails and shows receipts per step", () => {
    const md = renderCaseStudy({ mission, results });
    expect(md).not.toContain("sam@client.com");
    expect(md).toContain("<email>");
    expect(md).toContain("receipt: `send_email`");
    expect(md).toContain("✅ ok — 1 receipt(s)");
  });

  it("failed steps render the typed failure, anonymized", () => {
    const failed: StepResult[] = [
      {
        status: "failed",
        step_id: "s1",
        failure: { step_id: "s1", stage: "tool", component: "search_web", message: "quota for bob@x.io hit", retryable: true },
        tool_receipts: [],
      },
    ];
    const md = renderCaseStudy({ mission, results: failed });
    expect(md).toContain("❌ tool: quota for <email> hit");
    expect(md).toContain("not reached");
  });
});
