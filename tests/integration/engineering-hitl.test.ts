/**
 * Engineering CTO subgraph — nested HITL integration test.
 * Proves: parent → engineering(CTO) → devops → HITL-gated tool → interrupt()
 * surfaces via getState().tasks and resumes. REJECT → no write; APPROVE → tool runs.
 * Live Gemini (cheap) + MemorySaver; external tools are mocked. Skips without a real key.
 *
 * NOTE: The devops agent may use either github_write (create_issue/create_repo/update_readme)
 * or project_workflow (run_command: gh pr create …) depending on model routing. Both are
 * HITL-gated. The tests check that AN interrupt surfaces and that the appropriate mock
 * is called (or not) — without prescribing which exact tool the LLM picks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

// ── Mock external side-effects BEFORE importing the graph ─────────────────────

const githubExecute = vi.fn(async () => ({
  success: true,
  data: { html_url: "https://github.com/x/y/pull/1", number: 1 },
}));
vi.mock("../../src/tools/github.js", () => ({
  githubTool: { name: "github", description: "mock", execute: githubExecute },
}));

const projectWorkflowExecute = vi.fn(async () => ({
  success: true,
  data: "PR created: https://github.com/x/y/pull/1",
}));
vi.mock("../../src/tools/project-workflow.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    projectWorkflowTool: {
      name: "project_workflow",
      description: "mock",
      execute: projectWorkflowExecute,
    },
  };
});

vi.mock("../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, isSuppressed: vi.fn(async () => false) };
});

const { buildEngineeringNestedOffice } = await import("../../src/agents/engineering-domain.js");
const { getPendingApproval } = await import("../../src/agents/office.js");

// ── Guard: only run with a real Google key ────────────────────────────────────

const _gKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const hasRealKey = _gKey.length > 20 && !_gKey.includes("test");
const d = hasRealKey ? describe : describe.skip;

d("Engineering CTO nested HITL (parent → engineering → devops)", () => {
  beforeEach(() => {
    githubExecute.mockClear();
    projectWorkflowExecute.mockClear();
  });

  it("github write 3 levels deep → interrupt surfaces, REJECT → no write", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "eng-reject" } };
    await office.invoke(
      { messages: [new HumanMessage("Create a GitHub issue titled 'chore: bump deps' on repo pushkarverma3698/FounderOS with body 'Routine dependency update'.")] },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected a nested engineering approval interrupt").toBeTruthy();
    // The devops agent may use github_write or project_workflow — both are HITL-gated
    expect(approval!.action).toMatch(/github|project_workflow/);
    // Capture call counts at the interrupt point (read-only calls may have fired)
    const githubCallsAtInterrupt = githubExecute.mock.calls.length;
    const workflowCallsAtInterrupt = projectWorkflowExecute.mock.calls.length;
    await office.invoke(new Command({ resume: "rejected" }), config);
    // After reject: call counts must NOT increase (no new side-effects)
    expect(githubExecute.mock.calls.length).toBe(githubCallsAtInterrupt);
    expect(projectWorkflowExecute.mock.calls.length).toBe(workflowCallsAtInterrupt);
  });

  it("github write 3 levels deep → APPROVE → tool runs after resume", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = { configurable: { thread_id: "eng-approve" } };
    await office.invoke(
      { messages: [new HumanMessage("Create a GitHub issue titled 'chore: bump deps' on repo pushkarverma3698/FounderOS with body 'Routine dependency update'.")] },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval).toBeTruthy();
    // Capture call counts at the interrupt point
    const githubCallsAtInterrupt = githubExecute.mock.calls.length;
    const workflowCallsAtInterrupt = projectWorkflowExecute.mock.calls.length;
    await office.invoke(new Command({ resume: "approved" }), config);
    // After approve: total calls must have increased (the HITL tool ran)
    const totalAfter = githubExecute.mock.calls.length + projectWorkflowExecute.mock.calls.length;
    const totalBefore = githubCallsAtInterrupt + workflowCallsAtInterrupt;
    expect(totalAfter, "expected at least one tool execution after approval").toBeGreaterThan(totalBefore);
  });
});
