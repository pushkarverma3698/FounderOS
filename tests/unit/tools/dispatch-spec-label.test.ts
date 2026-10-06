/**
 * Pipeline v2, wave 3 step 1: with AGENT_PIPELINE_V2=1 a coding ask is filed as `agent:spec` (not `agent:ready`),
 * with the founder's words stored unmodified in the issue body. Flag unset: nothing changes.
 * Octokit is faked; the brief lint is the real one (scope is a file in this checkout).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockIssuesCreate = vi.fn();
const mockGetContent = vi.fn();
const mockRepoGet = vi.fn();
const mockKickDispatchTick = vi.fn();

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: { issues: { create: mockIssuesCreate }, repos: { getContent: mockGetContent, get: mockRepoGet } },
  })),
}));
vi.mock("../../../src/tools/dispatch-tick.js", () => ({ kickDispatchTick: mockKickDispatchTick }));

const { dispatchAntigravityTool, AGENT_READY_LABEL, ANTIGRAVITY_LABEL } = await import("../../../src/tools/dispatch-antigravity.js");
const { LABEL_SPEC } = await import("../../../src/tools/pipeline-pending.js");
const { AGENT_BRIEF_HEADINGS } = await import("../../../src/tools/agent-brief-lint.js");
const { resetBriefCheckMemo } = await import("../../../src/tools/dispatch-brief-check.js");

const BRIEF = {
  title: "feat: show closed issues toggle",
  goal: "Add a toggle",
  scope: "src/tools/dispatch-antigravity.ts",
  expected: "Closed issues are hidden",
  verification: "pnpm test tests/unit/tools/dispatch-antigravity.test.ts",
  problem: "The list shows closed issues.",
  evidence: "Seen in /tasks on 2026-10-06.",
  engine: "claude",
};
/** Quotes, a heading-looking line, a triple-backtick fence, trailing spaces and a blank line: all must survive. */
const ASK = "the /tasks list shows closed issues, hide them  \n\n## Goal\n```ts\nconst x = 1;\n```\n\"quoted\" > and done";

const created = () => mockIssuesCreate.mock.calls[0]?.[0] as { labels: string[]; body: string };

describe("dispatch_antigravity_task: spec intake behind AGENT_PIPELINE_V2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBriefCheckMemo();
    process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
    mockGetContent.mockResolvedValue({ data: {} });
    mockRepoGet.mockResolvedValue({ data: {} });
    mockIssuesCreate.mockResolvedValue({ data: { number: 77, html_url: "https://github.com/pushkarverma3698/FounderOS/issues/77", title: BRIEF.title } });
  });
  afterEach(() => {
    delete process.env["AGENT_PIPELINE_V2"];
  });

  it("flag on: labels are exactly [agent:spec, antigravity, engine:<x>], never agent:ready", async () => {
    process.env["AGENT_PIPELINE_V2"] = "1";
    const res = await dispatchAntigravityTool.execute({ ...BRIEF, founder_request: ASK });
    expect(res.success).toBe(true);
    expect(created().labels).toEqual([LABEL_SPEC, ANTIGRAVITY_LABEL, "engine:claude"]);
    expect(created().labels).not.toContain(AGENT_READY_LABEL);
    expect((res.data as { labels: string[] }).labels).toEqual(created().labels);
  });

  it("flag on: the ask is in the body byte for byte, inside a fence that outlasts the ask's own fence", async () => {
    process.env["AGENT_PIPELINE_V2"] = "1";
    await dispatchAntigravityTool.execute({ ...BRIEF, founder_request: ASK });
    const body = created().body;
    expect(body).toContain("## Founder request (verbatim)");
    expect(body).toContain(`\n${ASK}\n`);
    // The ask holds a 3-backtick fence, so the section fence must be 4: nothing in the ask can close it early.
    expect(body).toContain(`## Founder request (verbatim)\n\n\`\`\`\`\n${ASK}\n\`\`\`\``);
    expect(body.endsWith("````")).toBe(true); // trimmed like the formatter's own output
    for (const heading of AGENT_BRIEF_HEADINGS) expect(body).toContain(`## ${heading}\n`);
  });

  it("flag on: a missing ask files no verbatim section (the spec gate asks instead of guessing)", async () => {
    process.env["AGENT_PIPELINE_V2"] = "1";
    await dispatchAntigravityTool.execute({ ...BRIEF });
    expect(created().body).not.toContain("Founder request (verbatim)");
  });

  it("flag off: labels and body are exactly what they were", async () => {
    await dispatchAntigravityTool.execute({ ...BRIEF, founder_request: ASK });
    expect(created().labels).toEqual([AGENT_READY_LABEL, ANTIGRAVITY_LABEL, "engine:claude"]);
    expect(created().body).not.toContain("Founder request (verbatim)");
  });

  it.each(["0", "true", "", "yes"])("flag %j is off: still agent:ready", async (value) => {
    process.env["AGENT_PIPELINE_V2"] = value;
    await dispatchAntigravityTool.execute({ ...BRIEF, founder_request: ASK });
    expect(created().labels[0]).toBe(AGENT_READY_LABEL);
  });
});
