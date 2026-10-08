/** The agent tool's card summary and reply under AGENT_PIPELINE_V2 (execute() is stubbed; its labels decide the reply). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockHitlGate = vi.fn();
const mockDispatchExecute = vi.fn();
const mockLint = vi.fn();
const LINT_OK = { ok: true, missing: [], missingHeadings: [], emptyHeadings: [], missingPaths: [], otherProblems: [], warnings: [] };

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => ({ ...(await (orig() as Promise<Record<string, unknown>>)), hitlGate: mockHitlGate }));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: async () => false,
  writeAuditEntry: async () => ({ written: true }),
  listRegisteredDispatchRepos: async () => [],
}));
// AG-039: the reach check calls the network; these tests are about the card, not the network.
vi.mock("../../../src/tools/repo-reach.js", () => ({ checkRepoReach: async () => ({ ok: true }) }));
vi.mock("../../../src/tools/dispatch-antigravity.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  dispatchAntigravityTool: { execute: mockDispatchExecute },
  lintDispatchBrief: mockLint,
}));

const { dispatchAntigravityTask } = await import("../../../src/agents/agent-tools/antigravity.js");

const ARGS = {
  title: "feat: hide closed issues",
  scope: "src/tools/dispatch-antigravity.ts",
  founder_request: "hide closed issues in the tasks list",
  engine: "claude" as const,
};
const filed = (labels: string[]) => ({
  success: true,
  data: { issue_number: 77, issue_url: "https://github.com/x/y/issues/77", title: "t", repo: "pushkarverma3698/FounderOS", labels },
});

describe("dispatchAntigravityTask under AGENT_PIPELINE_V2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHitlGate.mockResolvedValue(null);
    mockLint.mockResolvedValue(LINT_OK);
  });
  afterEach(() => {
    delete process.env["AGENT_PIPELINE_V2"];
  });

  it("flag on: the card names agent:spec and the reply says a spec card follows", async () => {
    process.env["AGENT_PIPELINE_V2"] = "1";
    mockDispatchExecute.mockResolvedValue(filed(["agent:spec", "antigravity", "engine:claude"]));
    const reply = await dispatchAntigravityTask.invoke(ARGS);
    const card = mockHitlGate.mock.calls[0]?.[0] as { summary: string; preview: string };
    expect(card.summary).toContain("agent:spec issue");
    expect(card.summary).not.toContain("agent:ready");
    expect(reply).toMatch(/spec is being drafted/i);
    expect(reply).toMatch(/spec card will follow/i);
    expect(reply).not.toMatch(/queued|next tick|draft PR/i);
  });

  it("flag off: card and reply are the existing ones", async () => {
    mockDispatchExecute.mockResolvedValue(filed(["agent:ready", "antigravity", "engine:claude"]));
    const reply = await dispatchAntigravityTask.invoke(ARGS);
    const card = mockHitlGate.mock.calls[0]?.[0] as { summary: string };
    expect(card.summary).toContain("Open agent:ready issue on");
    expect(reply).toContain("✅ Dispatched to Claude Code: Issue #77");
    expect(reply).toContain("Its run started now");
  });
});
