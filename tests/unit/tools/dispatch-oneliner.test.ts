/**
 * One-line `/task`s are filed, not bounced (UX audit P1-7 / F15).
 *
 * A founder at a phone types "make the digest shorter". The planner has seen no repository, so it has no file
 * to cite: it leaves the scope out, or fills it with nothing. The brief lint refuses an empty "Files or subsystem
 * in scope" section, so every such request used to come back as "could not be dispatched". Antigravity reads the
 * whole repository; it is the party that can find the files. So an empty scope is filed as
 * "paths: agent to locate" and the approval card says so on its "Not verified" line.
 *
 * Runs the real tool and the real lint against a fake Octokit: $0, offline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIssuesCreate = vi.fn();
const mockGetContent = vi.fn();
const mockRepoGet = vi.fn();
const mockReadDefaultEngine = vi.fn();

vi.mock("octokit", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: { issues: { create: mockIssuesCreate }, repos: { getContent: mockGetContent, get: mockRepoGet } },
  })),
}));

vi.mock("../../../src/tools/dispatch-tick.js", () => ({ startDispatchJob: vi.fn().mockResolvedValue({ status: "inert" }), startFailureNote: () => "" }));

vi.mock("../../../src/tools/coding-engine.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  readDefaultEngine: mockReadDefaultEngine,
}));

const { dispatchAntigravityTool, formatAntigravityIssueBody, lintDispatchBrief } = await import(
  "../../../src/tools/dispatch-antigravity.js"
);
const { prepareDispatchBrief, SCOPE_UNKNOWN } = await import("../../../src/tools/dispatch-brief-repair.js");
const { renderCardPreview } = await import("../../../src/tools/dispatch-brief-preview.js");
const { resetBriefCheckMemo } = await import("../../../src/tools/dispatch-brief-check.js");

/** What the planner fills in around the founder's one line: everything except a file it has never seen. */
function oneLiner(request: string, scope?: string): Record<string, unknown> {
  return {
    title: `feat: ${request.slice(0, 40)}`,
    goal: `Do what the founder asked: ${request}`,
    expected: "The behavior the founder described, working end to end.",
    verification: "pnpm test && pnpm gate",
    founder_request: request,
    ...(scope === undefined ? {} : { scope }),
  };
}

/** Five one-line requests, each with a different way of having no file to name. */
const FIVE_ONE_LINERS: ReadonlyArray<{ name: string; args: Record<string, unknown>; guessed?: true }> = [
  { name: "scope omitted", args: oneLiner("add a /ping command that replies pong") },
  { name: "scope empty string", args: oneLiner("make the daily digest shorter", "") },
  { name: "scope whitespace only", args: oneLiner("fix the typo in the welcome message", " \n\t ") },
  { name: "scope is only an HTML comment", args: oneLiner("rename the engine command", "<!-- files here -->") },
  {
    name: "scope cites a path that does not exist",
    args: oneLiner("make pr-brain post less often", "src/agent/pr-brain.ts"),
    guessed: true,
  },
];

describe("one-line /task requests are filed, not bounced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDefaultEngine.mockReturnValue("agy");
    resetBriefCheckMemo();
    process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
    mockRepoGet.mockResolvedValue({ data: {} });
    // FounderOS paths are checked against this checkout, where src/agent/pr-brain.ts does not exist.
    mockGetContent.mockResolvedValue({ data: {} });
    let n = 700;
    mockIssuesCreate.mockImplementation(async (params: { title: string }) => ({
      data: { number: ++n, html_url: `https://github.com/pushkarverma3698/FounderOS/issues/${n}`, title: params.title },
    }));
  });

  it("files all five as five issues", async () => {
    const results = [];
    for (const fixture of FIVE_ONE_LINERS) {
      results.push({ fixture, res: await dispatchAntigravityTool.execute({ ...fixture.args }) });
    }

    for (const { fixture, res } of results) {
      expect(res.success, `${fixture.name}: ${res.error ?? ""}`).toBe(true);
    }
    expect(mockIssuesCreate).toHaveBeenCalledTimes(5);
    const numbers = results.map(({ res }) => (res.data as { issue_number: number }).issue_number);
    expect(new Set(numbers).size).toBe(5);
  });

  it("files the unknown scope as 'paths: agent to locate' and tells the founder it is unverified", async () => {
    for (const fixture of FIVE_ONE_LINERS.filter((f) => !f.guessed)) {
      mockIssuesCreate.mockClear();
      const res = await dispatchAntigravityTool.execute({ ...fixture.args });

      expect(res.success, fixture.name).toBe(true);
      const filed = mockIssuesCreate.mock.calls[0]?.[0] as { body: string };
      expect(filed.body, fixture.name).toContain("paths: agent to locate");
      const warnings = (res.data as { warnings?: string[] }).warnings ?? [];
      expect(warnings[0], fixture.name).toMatch(/no file paths/i);
    }
  });

  it("keeps a real scope exactly as the caller gave it", async () => {
    const res = await dispatchAntigravityTool.execute({ ...oneLiner("tighten the digest", "src/tools/dispatch-antigravity.ts") });

    expect(res.success).toBe(true);
    const filed = mockIssuesCreate.mock.calls[0]?.[0] as { body: string };
    expect(filed.body).not.toContain("paths: agent to locate");
    expect((res.data as { warnings?: string[] }).warnings ?? []).toEqual([]);
  });

  it("files a request whose goal, expected and verification the planner left out, from the founder's sentence", async () => {
    const res = await dispatchAntigravityTool.execute({
      title: "feat: shorter digest",
      founder_request: "make the daily digest shorter",
    });

    expect(res.success, res.error ?? "").toBe(true);
    const filed = mockIssuesCreate.mock.calls[0]?.[0] as { body: string };
    expect(filed.body).toContain("> make the daily digest shorter");
    expect(filed.body).toMatch(/## Verification commands\n\n[^#]*own checks/i);
    expect(filed.body).toContain("paths: agent to locate");
  });

  it("still refuses a blank goal when there is no founder request to fill it from", async () => {
    const full = { title: "feat: x", goal: "g", expected: "e", verification: "v" };
    for (const args of [{ ...full, goal: "" }, { ...full, goal: "  " }, { ...full, expected: "" }, { ...full, verification: undefined }]) {
      mockIssuesCreate.mockClear();
      const res = await dispatchAntigravityTool.execute(args);
      expect(res.success).toBe(false);
      expect(res.error).toContain("requires title, goal, expected, and verification");
      expect(mockIssuesCreate).not.toHaveBeenCalled();
    }
  });

  it("still refuses a brief that is missing something the tool cannot invent", async () => {
    const res = await dispatchAntigravityTool.execute({ title: "feat: x", goal: "g", scope: "", expected: "e" });
    expect(res.success).toBe(false);
    expect(res.error).toContain("requires title, goal, expected, and verification");
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });
});

describe("prepareDispatchBrief with no scope", () => {
  const deps = {
    lint: (body: string) => lintDispatchBrief({ owner: "pushkarverma3698", repo: "FounderOS" }, body),
    format: formatAntigravityIssueBody,
  };

  beforeEach(() => {
    resetBriefCheckMemo();
  });

  it("fills the scope and puts the warning first, so the card line names it", async () => {
    const prepared = await prepareDispatchBrief(
      { title: "t", goal: "g", scope: "", expected: "e", verification: "v" },
      "make it faster",
      deps,
    );

    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.input.scope).toBe(SCOPE_UNKNOWN);
    expect(prepared.warnings[0]).toMatch(/no file paths/i);
  });

  it("renders the card's 'Filled from your sentence' line only when something was filled", () => {
    const base = { title: "t", goal: "g", scope: "", expected: "e", verification: "v" };
    const filled = renderCardPreview(base, { bodyChars: 900, filled: ["Goal", "Expected", "Verification"] });
    expect(filled).toContain("Filled from your sentence: Goal, Expected, Verification");
    expect(renderCardPreview(base, { bodyChars: 900 })).not.toContain("Filled from your sentence");
    expect(renderCardPreview(base, { bodyChars: 900, filled: [] })).not.toContain("Filled from your sentence");
  });

  it("renders the card's Files line without the blank, and with the unverified line", () => {
    const card = renderCardPreview(
      { title: "t", goal: "g", scope: "", expected: "e", verification: "v" },
      { bodyChars: 900, warnings: ["No file paths were given, so the scope is filed as 'paths: agent to locate'."] },
    );

    expect(card).toContain("Files: paths: agent to locate");
    expect(card).toContain("Not verified: No file paths were given");
  });
});
