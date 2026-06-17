/**
 * Engineering CTO subgraph — nested HITL integration test.
 * Proves: parent → engineering(CTO) → devops → HITL-gated tool → interrupt()
 * surfaces via getState().tasks. APPROVE → tool runs.
 *
 * REJECT path: production resumeOffice clears the thread and NEVER resumes
 * rejected into the graph (reject-no-redraft.test.ts). Nested 3-level graphs
 * loop to recursion limit if we Command({ resume: "rejected" }) here — so we
 * only assert interrupt + zero side-effects at pause (same safety guarantee).
 *
 * Live Gemini + MemorySaver; external tools mocked. Skips without a real key.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { OFFICE_RECURSION_LIMIT } from "../../src/core/config.js";

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

const _gKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"] ?? "";
const hasRealKey = _gKey.length > 20 && !_gKey.includes("test");
const d = hasRealKey ? describe : describe.skip;

const ISSUE_PROMPT =
  "Open a new GitHub issue on repo pushkarverma3698/FounderOS. Title: 'chore: bump deps'. Body: 'Routine dependency update'. Use your tools to actually create it now — do not assume it already exists.";

function invokeConfig(threadId: string) {
  return { configurable: { thread_id: threadId }, recursionLimit: OFFICE_RECURSION_LIMIT };
}

d("Engineering CTO nested HITL (parent → engineering → devops)", () => {
  beforeEach(() => {
    githubExecute.mockClear();
    projectWorkflowExecute.mockClear();
  });

  it("github write 3 levels deep → interrupt surfaces, no HITL side-effect at pause", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = invokeConfig("eng-reject");
    await office.invoke({ messages: [new HumanMessage(ISSUE_PROMPT)] }, config);
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected a nested engineering approval interrupt").toBeTruthy();
    expect(approval!.action).toMatch(/github|project_workflow/);
    // HITL-gated writes must not run before founder approval
    expect(githubExecute).not.toHaveBeenCalled();
    expect(projectWorkflowExecute).not.toHaveBeenCalled();
  });

  it("github write 3 levels deep → APPROVE → tool runs after resume", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = invokeConfig("eng-approve");
    await office.invoke({ messages: [new HumanMessage(ISSUE_PROMPT)] }, config);
    const approval = await getPendingApproval(office, config);
    expect(approval).toBeTruthy();
    const githubCallsAtInterrupt = githubExecute.mock.calls.length;
    const workflowCallsAtInterrupt = projectWorkflowExecute.mock.calls.length;
    await office.invoke(new Command({ resume: "approved" }), config);
    const githubDelta = githubExecute.mock.calls.length - githubCallsAtInterrupt;
    const workflowDelta = projectWorkflowExecute.mock.calls.length - workflowCallsAtInterrupt;
    expect(githubDelta + workflowDelta, "expected the approved HITL tool to run after resume").toBeGreaterThanOrEqual(1);
  });

  it("read-only engineering task → routes to coder/qa, NO interrupt (control)", { timeout: 90_000 }, async () => {
    const office = buildEngineeringNestedOffice(new MemorySaver());
    const config = invokeConfig("eng-control");
    await office.invoke(
      {
        messages: [
          new HumanMessage(
            "Read repo pushkarverma3698/FounderOS and tell me what its description and default branch are. Do not change anything.",
          ),
        ],
      },
      config,
    );
    const approval = await getPendingApproval(office, config);
    expect(approval, "a read-only task should NOT need approval").toBeNull();
    expect(projectWorkflowExecute).not.toHaveBeenCalled();
  });
});
