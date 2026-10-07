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

vi.mock("../../../src/tools/dispatch-tick.js", () => ({ startDispatchJob: vi.fn().mockResolvedValue({ status: "inert" }), startFailureNote: () => "" }));

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

  it("files a path GitHub says is not there as an unverified hint, says so on the card, and still asks for ONE approval", async () => {
    // 2026-10-02: every plain-English /task died here, because the planner invents paths for repos it has never
    // seen. The path is not rejected any more; it is demoted, and the founder is told on the card.
    mockGetContent.mockImplementation(async (params: { path: string }) => {
      if (params.path === "src/api.ts") throw Object.assign(new Error("Not Found"), { status: 404 });
      return { data: {} };
    });

    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(reply).toContain("✅ Dispatched to Google Antigravity: Issue #77");
    expect(reply).toContain("⚠️ Not found in the repository, so filed as unverified hints, not facts: src/api.ts.");
    expect(mockHitlGate).toHaveBeenCalledTimes(1);
    const preview = (mockHitlGate.mock.calls[0]?.[0] as { preview: string }).preview;
    expect(preview).toContain("Not verified: Not found in the repository, so filed as unverified hints, not facts: src/api.ts.");
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(filed).toContain("src/app.ts"); // the path that exists stays a fact
    expect(filed).toContain("[unverified path 1]");
    expect(filed).toContain("```text\n1. src/api.ts\n```");
    // Before the card: the brief as written (2 paths, one is a 404), then the repaired brief (1 path). execute()
    // repeats the first lookup (a failing body is never memoised: a path created since must be seen) and finds
    // the repaired one in the memo. A demotion costs two extra lookups; no other brief pays them.
    expect(mockGetContent).toHaveBeenCalledTimes(5);
  });

  it("files a request with NO evidence when the founder's own words come with it: they are the evidence", async () => {
    const reply = await dispatchAntigravityTask.invoke({ ...BRIEF, evidence: undefined, founder_request: "make the login button bigger on mobile" });

    expect(reply).toContain("✅ Dispatched to Google Antigravity: Issue #77");
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(filed).toContain("## Evidence\n\nThe founder's request, verbatim:\n\n> make the login button bigger on mobile");
    expect(mockHitlGate).toHaveBeenCalledTimes(1);
  });

  it("one sentence is enough: goal, expected and verification omitted, ONE card that says what was filled", async () => {
    // C-P0-2. A cheap planner that leaves these out used to bounce at the schema before any card existed.
    const reply = await dispatchAntigravityTask.invoke({
      title: BRIEF.title,
      repo: BRIEF.repo,
      founder_request: "make the daily digest shorter",
    });

    expect(reply).toContain("✅ Dispatched to Google Antigravity: Issue #77");
    expect(mockHitlGate).toHaveBeenCalledTimes(1);
    const preview = (mockHitlGate.mock.calls[0]?.[0] as { preview: string }).preview;
    expect(preview).toContain("Filled from your sentence: Goal, Expected, Verification");
    expect(preview).toContain("Files: paths: agent to locate");
    expect(preview).toContain("make the daily digest shorter");
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    for (const heading of AGENT_BRIEF_HEADINGS) expect(filed).toContain(`## ${heading}\n`);
  });

  it("without the founder's sentence a blank goal is text to the model: no card, nothing filed, and no question for the founder", async () => {
    const reply = await dispatchAntigravityTask.invoke({ title: BRIEF.title, repo: BRIEF.repo });

    expect(reply).toContain("founder_request");
    expect(reply).toMatch(/do not ask the founder/i);
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
