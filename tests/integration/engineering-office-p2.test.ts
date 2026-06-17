/**
 * P2 — Full office + ENGINEERING_SUBGRAPH=1 nested HITL integration test.
 * Proves the live office wiring (not the isolated test harness): COS → engineering
 * (CTO subgraph) → devops → HITL-gated github_write surfaces via getState().tasks.
 *
 * Uses buildOfficeInput (real gateway pre-router path) for deterministic routing.
 * Live model + MemorySaver; external tools mocked. Skips without a real API key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { OFFICE_RECURSION_LIMIT } from "../../src/core/config.js";
import { hasReliableNestedIntegrationModel } from "./live-model-guard.js";

const githubExecute = vi.fn(async (input: { action?: string }) => {
  if (input?.action && input.action !== "read") {
    return { success: true, data: { html_url: "https://github.com/x/y/issues/1", number: 1 } };
  }
  return {
    success: true,
    data: { description: "FounderOS", default_branch: "main", full_name: "pushkarverma3698/FounderOS" },
  };
});
vi.mock("../../src/tools/github.js", () => ({
  githubTool: { name: "github", description: "mock", execute: githubExecute },
}));

const projectWorkflowExecute = vi.fn(async () => ({
  success: true,
  data: "Issue created: https://github.com/x/y/issues/1",
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

const ISSUE_PROMPT =
  "Create a GitHub issue on pushkarverma3698/FounderOS titled 'chore: P2 nested HITL verify' with body 'Integration test for CTO subgraph wiring'. Use your tools to actually create it now.";

function invokeConfig(threadId: string) {
  return { configurable: { thread_id: threadId }, recursionLimit: OFFICE_RECURSION_LIMIT };
}
async function compileP2Office() {
  vi.resetModules();
  process.env["ENGINEERING_SUBGRAPH"] = "1";
  const { buildOffice, getPendingApproval } = await import("../../src/agents/office.js");
  const { buildOfficeInput } = await import("../../src/gateway/pre-router.js");
  return {
    office: buildOffice(new MemorySaver()),
    getPendingApproval,
    messages: buildOfficeInput(ISSUE_PROMPT),
  };
}

const d = hasReliableNestedIntegrationModel() ? describe : describe.skip;

d("P2 — full office + ENGINEERING_SUBGRAPH=1 nested HITL", () => {
  beforeEach(() => {
    githubExecute.mockClear();
    projectWorkflowExecute.mockClear();
    delete process.env["ENGINEERING_SUBGRAPH"];
  });

  it("github write via live office → interrupt surfaces, no side-effect at pause", { timeout: 120_000 }, async () => {
    const { office, getPendingApproval, messages } = await compileP2Office();
    const config = invokeConfig(`p2-office-interrupt-${Date.now()}`);

    await office.invoke({ messages }, config);
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected nested engineering approval via full office").toBeTruthy();
    expect(approval!.action).toMatch(/github|project_workflow/);
    expect(githubExecute).not.toHaveBeenCalled();
    expect(projectWorkflowExecute).not.toHaveBeenCalled();
  });

  it("github write via live office → APPROVE → tool runs after resume", { timeout: 120_000 }, async () => {
    const { office, getPendingApproval, messages } = await compileP2Office();
    const config = invokeConfig(`p2-office-approve-${Date.now()}`);

    await office.invoke({ messages }, config);
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected nested engineering approval via full office").toBeTruthy();

    const githubAtPause = githubExecute.mock.calls.length;
    const workflowAtPause = projectWorkflowExecute.mock.calls.length;
    await office.invoke(new Command({ resume: "approved" }), config);
    const delta =
      githubExecute.mock.calls.length -
      githubAtPause +
      (projectWorkflowExecute.mock.calls.length - workflowAtPause);
    expect(delta, "approved HITL tool should run after resume").toBeGreaterThanOrEqual(1);
  });

  it("read-only github task → NO interrupt (control)", { timeout: 120_000 }, async () => {
    const { office, getPendingApproval } = await compileP2Office();
    const { buildOfficeInput } = await import("../../src/gateway/pre-router.js");
    const config = invokeConfig(`p2-office-read-${Date.now()}`);

    await office.invoke(
      {
        messages: buildOfficeInput(
          "List my GitHub repositories on pushkarverma3698 — read only, do not create or change anything.",
        ),
      },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval, "read-only task should NOT need approval").toBeNull();
    expect(projectWorkflowExecute).not.toHaveBeenCalled();
  });
});
