/**
 * AG-039: the repo-reach refusal, wired for real: LangChain wrapper -> reach check -> (never) the approval gate ->
 * execute() -> GitHub. Only the edges are stubbed (approval gate, database, GitHub client). An unreachable repo
 * must be refused in chat with GitHub's status and message, cost the founder no approval, and file nothing.
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
const { dispatchAntigravityTool } = await import("../../../src/tools/dispatch-antigravity.js");
const { resetBriefCheckMemo } = await import("../../../src/tools/dispatch-brief-check.js");

const BRIEF = {
  title: "fix: retry budget is spent on 4xx",
  goal: "Stop the sweep spending its retry budget on 4xx responses.",
  scope: "src/app.ts",
  expected: "A 4xx is a permanent failure and is never retried.",
  verification: "npm test",
  problem: "Every 404 is retried three times.",
  evidence: "The sweep log of 2026-09-20 shows 1,204 retries on 404s.",
  repo: "OplifyMessage/oplify-messaging-api",
};

const gitHubError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

beforeEach(() => {
  vi.clearAllMocks();
  resetBriefCheckMemo();
  process.env["GITHUB_TOKEN"] = ["fake", "token", "for", "tests"].join("_");
  mockHasBeenAudited.mockResolvedValue(false);
  mockWriteAuditEntry.mockResolvedValue({ written: true });
  mockHitlGate.mockResolvedValue(null);
  mockGetContent.mockResolvedValue({ data: {} });
  mockRepoGet.mockResolvedValue({ data: { permissions: { push: true } } });
  mockIssuesCreate.mockResolvedValue({
    data: { number: 77, html_url: "https://github.com/OplifyMessage/oplify-messaging-api/issues/77", title: BRIEF.title },
  });
});

describe("/task on a repo the bot's token cannot reach", () => {
  it("replies in chat with the repo, GitHub's status and message, and files nothing", async () => {
    mockRepoGet.mockRejectedValue(gitHubError(404, "Not Found"));

    const reply = String(await dispatchAntigravityTask.invoke({ ...BRIEF }));

    expect(reply).toContain("OplifyMessage/oplify-messaging-api");
    expect(reply).toContain("404");
    expect(reply).toContain("Not Found");
    expect(reply).toContain("the bot's GITHUB_TOKEN cannot reach this repo");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it("refuses a token with no push permission the same way", async () => {
    mockRepoGet.mockResolvedValue({ data: { permissions: { admin: false, maintain: false, push: false, pull: true } } });

    const reply = String(await dispatchAntigravityTask.invoke({ ...BRIEF }));

    expect(reply).toContain("no push permission");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it("execute() refuses on its own too: it is the last thing before issues.create", async () => {
    mockRepoGet.mockRejectedValue(gitHubError(403, "Resource not accessible by personal access token"));

    const res = await dispatchAntigravityTool.execute({ ...BRIEF });

    expect(res.success).toBe(false);
    expect(res.error).toContain("403");
    expect(res.error).toContain("the bot's GITHUB_TOKEN cannot reach this repo");
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it("still files when the token can push", async () => {
    const reply = String(await dispatchAntigravityTask.invoke({ ...BRIEF }));

    expect(reply).toContain("Dispatched to Google Antigravity: Issue #77");
    expect(mockIssuesCreate).toHaveBeenCalledTimes(1);
  });
});
