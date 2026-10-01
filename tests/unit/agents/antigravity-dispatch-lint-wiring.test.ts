/**
 * The brief lint, wired for real: LangChain wrapper → lint → approval gate → execute() → GitHub.
 * ============================================================================================
 * antigravity-dispatch-hitl.test.ts stubs the lint and dispatch-antigravity.test.ts calls
 * execute() directly; each proves its own half. This file stubs only the edges (the approval
 * gate, the database, the GitHub client) and runs the real wrapper, the real lint and the real
 * tool, so it proves what the halves cannot: that the pre-approval lint and execute() share one
 * set of GitHub lookups, that a rejected brief costs the founder no approval, and that what is
 * filed has all nine sections.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockHasBeenAudited = vi.fn();
const mockWriteAuditEntry = vi.fn();
const mockIssuesCreate = vi.fn();
const mockGetContent = vi.fn();
const mockRepoGet = vi.fn();

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      issues: { create: mockIssuesCreate },
      repos: { getContent: mockGetContent, get: mockRepoGet },
    },
  })),
}));

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, hitlGate: mockHitlGate };
});

vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: mockHasBeenAudited,
  writeAuditEntry: mockWriteAuditEntry,
  listRegisteredDispatchRepos: async () => [],
}));

vi.mock("../../../src/tools/dispatch-tick.js", () => ({ kickDispatchTick: vi.fn() }));

const { dispatchAntigravityTask } = await import("../../../src/agents/agent-tools/antigravity.js");
const { AGENT_BRIEF_HEADINGS } = await import("../../../src/tools/agent-brief-lint.js");
const { resetBriefCheckMemo } = await import("../../../src/tools/dispatch-brief-check.js");

const BRIEF = {
  title: "fix: retry budget is spent on 4xx",
  goal: "Stop the sweep spending its retry budget on 4xx responses.",
  scope: "src/app.ts, src/api.ts",
  expected: "A 4xx is a permanent failure and is never retried.",
  verification: "npm test",
  problem: "Every 404 is retried three times.",
  evidence: "The sweep log of 2026-09-20 shows 1,204 retries on 404s.",
  repo: "OplifyMessage/oplify-messaging-api",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetBriefCheckMemo();
  process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
  mockHasBeenAudited.mockResolvedValue(false);
  mockWriteAuditEntry.mockResolvedValue({ written: true });
  mockHitlGate.mockResolvedValue(null); // approved
  mockGetContent.mockResolvedValue({ data: {} });
  mockRepoGet.mockResolvedValue({ data: {} });
  mockIssuesCreate.mockResolvedValue({
    data: { number: 77, html_url: "https://github.com/OplifyMessage/oplify-messaging-api/issues/77", title: BRIEF.title },
  });
});

describe("dispatch_antigravity_task with the real lint", () => {
  it("costs one set of GitHub lookups for the whole dispatch, and files all nine sections", async () => {
    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(reply).toContain("✅ Dispatched to Google Antigravity: Issue #77");
    // Two paths, looked up once before the card. execute() found the verdict in the memo.
    expect(mockGetContent).toHaveBeenCalledTimes(2);
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    for (const heading of AGENT_BRIEF_HEADINGS) expect(filed).toContain(`## ${heading}\n`);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the lookups when the run is replayed from the top after approval", async () => {
    // hitlGate re-runs the tool from the top on resume. Same process, same brief: the memo holds.
    await dispatchAntigravityTask.invoke({ ...BRIEF });
    await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(mockGetContent).toHaveBeenCalledTimes(2);
  });

  it("asks the founder nothing for a brief that will be rejected: text to the model, no card, nothing filed", async () => {
    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF, evidence: undefined });

    expect(reply).toContain("❌ Brief rejected: nothing was filed on OplifyMessage/oplify-messaging-api.");
    expect(reply).toContain('Section "## Evidence" is empty');
    expect(reply).toContain("Pass it in the `evidence` input.");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("rejects a path GitHub says is not there, before the card, naming the repo it looked in", async () => {
    mockGetContent.mockImplementation(async (params: { path: string }) => {
      if (params.path === "src/api.ts") throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: {} };
    });

    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(reply).toContain("`src/api.ts` does not exist in OplifyMessage/oplify-messaging-api.");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it("still dispatches, and tells the founder what it could not check, when GitHub is down", async () => {
    mockGetContent.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { status: 503 }));

    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(reply).toContain("✅ Dispatched to Google Antigravity: Issue #77");
    expect(reply).toContain("⚠️ Could not verify 2 of 2 paths (Service Unavailable)");
    const preview = (mockHitlGate.mock.calls[0]?.[0] as { preview: string }).preview;
    expect(preview).toContain("Not verified: Could not verify 2 of 2 paths");
  });
});
