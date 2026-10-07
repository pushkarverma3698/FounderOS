/**
 * Unit tests for the Antigravity dispatch tool.
 * Mocks Octokit — runs offline at $0 cost with no live API calls or real tokens.
 *
 * The brief lint is NOT mocked here: FounderOS scope paths are read from this very checkout
 * and other repos go through the fake Octokit, so these tests exercise the real gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const mockIssuesCreate = vi.fn();
const mockGetContent = vi.fn();
const mockRepoGet = vi.fn();
const mockStartDispatchJob = vi.fn(async (..._a: unknown[]): Promise<{ status: string; reason?: string }> => ({ status: "started" }));
const mockReadDefaultEngine = vi.fn();

vi.mock("octokit", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        issues: { create: mockIssuesCreate },
        repos: { getContent: mockGetContent, get: mockRepoGet },
      },
    })),
  };
});

vi.mock("../../../src/tools/dispatch-tick.js", () => ({
  startDispatchJob: mockStartDispatchJob,
  startFailureNote: (n: number, repo: string, reason: string) => `could not start ${repo}#${n}: ${reason}`,
}));

// The default engine is a file under the real home directory. A test that read it would
// pass or fail with whatever the developer last typed into /engine.
vi.mock("../../../src/tools/coding-engine.js", async (orig) => ({
  ...(await (orig() as Promise<Record<string, unknown>>)),
  readDefaultEngine: mockReadDefaultEngine,
}));

const {
  dispatchAntigravityTool,
  formatAntigravityIssueBody,
  lintDispatchBrief,
  describeBriefRejection,
  resolveDispatchRepo,
  DEFAULT_DISPATCH_REPO,
  AGENT_READY_LABEL,
  ANTIGRAVITY_LABEL,
  STANDING_CONSTRAINTS,
} = await import("../../../src/tools/dispatch-antigravity.js");
const { AGENT_BRIEF_HEADINGS, lintAgentBrief } = await import("../../../src/tools/agent-brief-lint.js");
const { checkoutFileExists, resetBriefCheckMemo } = await import("../../../src/tools/dispatch-brief-check.js");
const { repoRoot } = await import("../../../src/evolution/repo-root.js");

const OPLIFY = "OplifyMessage/oplify-messaging-api";

/**
 * A brief that passes the lint against this checkout. `scope` is a file that exists here, and
 * `problem` and `evidence` are the two template sections the tool cannot invent.
 */
const COMPLETE = {
  title: "feat: 13k ATS scaling with per-domain rate limiting",
  goal: "Implement per-domain token bucket rate limiting",
  scope: "src/tools/dispatch-antigravity.ts",
  expected: "Replace global concurrency with domain rate limits",
  verification: "pnpm test tests/unit/tools/dispatch-antigravity.test.ts",
  problem: "Sweeps trip 429s on SmartRecruiters and Greenhouse.",
  evidence: "Observed 429 rate limit triggers in the 2026-09-20 sweep log.",
};

/** GitHub knows exactly these paths; everything else is a definite 404. */
function githubHas(...paths: string[]): void {
  mockGetContent.mockImplementation(async (params: { path: string }) => {
    if (paths.includes(params.path)) return { data: {} };
    throw Object.assign(new Error("Not Found"), { status: 404 });
  });
}

function issueCreated(): { number: number; html_url: string; title: string } {
  return { number: 524, html_url: "https://github.com/pushkarverma3698/FounderOS/issues/524", title: COMPLETE.title };
}

describe("formatAntigravityIssueBody", () => {
  it("emits all nine template headings, in the template's order", () => {
    const body = formatAntigravityIssueBody(COMPLETE);

    const template = readFileSync(new URL("../../../.github/ISSUE_TEMPLATE/agent-task.md", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    const emitted = body
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());

    expect(emitted).toEqual(template);
    expect(emitted).toEqual([...AGENT_BRIEF_HEADINGS]);
  });

  it("formats every section from its own input", () => {
    const body = formatAntigravityIssueBody({
      title: "feat: 13k ATS scaling",
      goal: "Scale free ATS ingestion to sweep 13,000 boards within 30 minutes.",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Implement per-domain token-bucket rate limiter and ETag conditional GET caching.",
      verification: "pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate",
      acceptance: "Green tests and ETag 304 responses skip re-downloading.",
      forbidden: "Do not touch metered scraping endpoints.",
      problem: "The sweep takes 4 hours.",
      evidence: "Observed 429 rate limit triggers on SmartRecruiters and Greenhouse.",
    });

    expect(body).toContain("## Goal\n\nScale free ATS ingestion");
    expect(body).toContain("## Problem / observed behavior\n\nThe sweep takes 4 hours.\n\n## Expected behavior");
    expect(body).toContain("## Expected behavior\n\nImplement per-domain token-bucket");
    expect(body).toContain("## Evidence\n\nObserved 429 rate limit triggers on SmartRecruiters and Greenhouse.\n\n## Files");
    expect(body).toContain("## Files or subsystem in scope\n\nsrc/tools/jobhunt/free-ats-source.ts");
    expect(body).toContain("## Explicitly forbidden\n\nDo not touch metered scraping endpoints.");
    expect(body).toContain("## Verification commands\n\npnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate");
    expect(body).toContain("## Acceptance criteria\n\nGreen tests and ETag 304 responses skip re-downloading.");
  });

  it("applies sensible defaults to forbidden and acceptance only", () => {
    const body = formatAntigravityIssueBody({
      title: "fix: token bucket",
      goal: "Fix bucket leak",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Leak fixed",
      verification: "pnpm test",
    });

    expect(body).toContain("## Explicitly forbidden\n\nSee docs/antigravity/STANDARDS.md");
    expect(body).toContain("## Acceptance criteria\n\nAll verification commands pass; the independent reviewer (pr-brain) clears the review with no BLOCKER.");
  });

  it("leaves Problem and Evidence EMPTY, with no placeholder, when the planner supplied neither", async () => {
    // The old body filled Problem with "Task dispatched by Founder via FounderOS." That text let
    // #762 through with an empty problem statement. An empty section makes the lint say so, and
    // the planner asks the founder instead of the gate passing hollowly.
    const body = formatAntigravityIssueBody({
      title: "fix: x",
      goal: "g",
      scope: "src/tools/index.ts",
      expected: "e",
      verification: "pnpm test",
    });

    expect(body).not.toContain("Task dispatched by Founder");
    const verdict = await lintAgentBrief(body, () => true);
    expect(verdict.missingHeadings).toEqual(["Problem / observed behavior", "Evidence"]);
    expect(verdict.emptyHeadings).toEqual(["Problem / observed behavior", "Evidence"]);
  });

  it("always carries the standing constraints, then appends the founder's own", () => {
    const plain = formatAntigravityIssueBody(COMPLETE);
    const withOwn = formatAntigravityIssueBody({ ...COMPLETE, constraints: "Keep the public retry API unchanged." });

    for (const rule of STANDING_CONSTRAINTS) {
      expect(plain).toContain(`- ${rule}`);
      expect(withOwn).toContain(`- ${rule}`);
    }
    expect(plain).not.toContain("Task-specific constraints");
    expect(withOwn).toContain("Task-specific constraints:\n\nKeep the public retry API unchanged.");
    expect(withOwn.indexOf("Keep the public retry API")).toBeGreaterThan(withOwn.indexOf(STANDING_CONSTRAINTS[0] as string));
    expect(withOwn.indexOf("Keep the public retry API")).toBeLessThan(withOwn.indexOf("## Explicitly forbidden"));
  });

  it("lists new files under a sub-heading of the scope section, where the lint does not look for them", async () => {
    const body = formatAntigravityIssueBody({ ...COMPLETE, newFiles: "src/tools/rate-limiter-new.ts" });

    expect(body).toContain(
      "## Files or subsystem in scope\n\nsrc/tools/dispatch-antigravity.ts\n\n### New files to create\n\nsrc/tools/rate-limiter-new.ts\n\n## Constraints",
    );
    const lookups: string[] = [];
    const verdict = await lintAgentBrief(body, (p) => (lookups.push(p), true));
    expect(verdict.ok).toBe(true);
    expect(lookups).toEqual(["src/tools/dispatch-antigravity.ts"]);
  });

  it("produces a body that passes the lint against this checkout (the real /task path)", async () => {
    const verdict = await lintAgentBrief(formatAntigravityIssueBody(COMPLETE), checkoutFileExists(repoRoot()));

    expect(verdict).toMatchObject({ ok: true, missing: [], warnings: [] });
  });
});

describe("STANDING_CONSTRAINTS", () => {
  it("holds real standing rules from STANDARDS.md and CLAUDE.md, one sentence each", () => {
    expect(STANDING_CONSTRAINTS.length).toBeGreaterThanOrEqual(5);
    for (const rule of STANDING_CONSTRAINTS) {
      expect(rule.length).toBeGreaterThan(20);
      expect(rule.length).toBeLessThanOrEqual(200);
      expect(rule.trimEnd().endsWith(".")).toBe(true);
    }
    const all = STANDING_CONSTRAINTS.join("\n").toLowerCase();
    expect(all).toContain("docs/antigravity/standards.md");
    expect(all).toContain("files listed in scope");
    expect(all).toContain("surrounding code's style");
    expect(all).toContain("no npm dependency");
    expect(all).toContain("never push to, or merge into, main");
  });
});

describe("resolveDispatchRepo", () => {
  it("uses provided repo argument when it is on the allowlist", async () => {
    expect(await resolveDispatchRepo("pushkarverma3698/House-of-Hulda-Website-frontend")).toEqual({
      owner: "pushkarverma3698",
      repo: "House-of-Hulda-Website-frontend",
    });
  });

  it("refuses a caller-supplied repo that is not on the allowlist", async () => {
    // `repo` is model-supplied and takes precedence over every env var, so this is the
    // one path between a malformed instruction and any repo the token can write to.
    await expect(resolveDispatchRepo("custom-owner/custom-repo")).rejects.toThrow(
      /not on the Antigravity dispatch allowlist/,
    );
  });

  it("falls back to DEFAULT_DISPATCH_REPO when no argument or env var is set", async () => {
    const orig = process.env["ISSUE_REPO"];
    delete process.env["ISSUE_REPO"];
    delete process.env["SELF_IMPROVE_ISSUE_REPO"];
    try {
      expect(await resolveDispatchRepo()).toEqual({
        owner: "pushkarverma3698",
        repo: "FounderOS",
      });
    } finally {
      if (orig) process.env["ISSUE_REPO"] = orig;
    }
  });

  it("treats ISSUE_REPO as a target, not a bypass", async () => {
    // The VPS crontab sets ISSUE_REPO. If that box is ever misconfigured, dispatch must
    // fail loudly rather than quietly file issues somewhere unwatched.
    const orig = process.env["ISSUE_REPO"];
    process.env["ISSUE_REPO"] = "someone-else/somewhere";
    delete process.env["SELF_IMPROVE_ISSUE_REPO"];
    try {
      await expect(resolveDispatchRepo()).rejects.toThrow(/not on the Antigravity dispatch allowlist/);
    } finally {
      if (orig) process.env["ISSUE_REPO"] = orig;
      else delete process.env["ISSUE_REPO"];
    }
  });

  it("throws error for malformed slug", async () => {
    await expect(resolveDispatchRepo("invalid-slug-without-slash")).rejects.toThrow(/Invalid repository slug/);
  });
});

describe("dispatchAntigravityTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDefaultEngine.mockReturnValue("agy");
    resetBriefCheckMemo();
    process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
    mockGetContent.mockResolvedValue({ data: {} });
    mockRepoGet.mockResolvedValue({ data: {} });
  });

  it("rejects if required fields are missing", async () => {
    const res = await dispatchAntigravityTool.execute({
      title: "Incomplete task",
      goal: "Only goal provided",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("dispatch_antigravity_task requires title, goal, expected, and verification");
  });

  it("returns error if GITHUB_TOKEN is missing", async () => {
    delete process.env["GITHUB_TOKEN"];
    const res = await dispatchAntigravityTool.execute({ ...COMPLETE });
    expect(res.success).toBe(false);
    expect(res.error).toContain("GITHUB_TOKEN not configured");
  });

  it("creates issue with agent:ready, antigravity and engine labels, and the full nine-section body", async () => {
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE });

    expect(res.success).toBe(true);
    expect(mockIssuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "pushkarverma3698",
        repo: "FounderOS",
        title: "feat: 13k ATS scaling with per-domain rate limiting",
        labels: [AGENT_READY_LABEL, ANTIGRAVITY_LABEL, "engine:agy"],
      }),
    );
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    for (const heading of AGENT_BRIEF_HEADINGS) expect(filed).toContain(`## ${heading}\n`);
    expect(filed).toContain("## Evidence\n\nObserved 429 rate limit triggers in the 2026-09-20 sweep log.");

    const data = res.data as { issue_number: number; issue_url: string; repo: string; warnings?: string[] };
    expect(data.issue_number).toBe(524);
    expect(data.issue_url).toBe("https://github.com/pushkarverma3698/FounderOS/issues/524");
    expect(data.repo).toBe("pushkarverma3698/FounderOS");
    expect(data.warnings).toBeUndefined();
  });

  it("labels the issue for the engine the caller named, and does not read the default", async () => {
    mockReadDefaultEngine.mockReturnValue("agy");
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, engine: "claude" });

    expect(res.success).toBe(true);
    expect(mockIssuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [AGENT_READY_LABEL, ANTIGRAVITY_LABEL, "engine:claude"] }),
    );
    expect(mockReadDefaultEngine).not.toHaveBeenCalled();
    expect((res.data as { engine: string }).engine).toBe("claude");
  });

  it("falls back to the default engine at filing time when none is named", async () => {
    mockReadDefaultEngine.mockReturnValue("claude");
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE });

    expect(mockIssuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({ labels: [AGENT_READY_LABEL, ANTIGRAVITY_LABEL, "engine:claude"] }),
    );
    expect((res.data as { engine: string }).engine).toBe("claude");
  });

  it("always files exactly one engine label, so the daemon never meets an ambiguous issue", async () => {
    mockIssuesCreate.mockResolvedValue({ data: issueCreated() });
    for (const engine of ["agy", "claude", undefined]) {
      mockIssuesCreate.mockClear();
      await dispatchAntigravityTool.execute({ ...COMPLETE, ...(engine ? { engine } : {}) });
      const labels = (mockIssuesCreate.mock.calls[0]?.[0] as { labels: string[] }).labels;
      expect(labels.filter((l) => l.startsWith("engine:"))).toHaveLength(1);
    }
  });

  it("refuses an engine it does not know and files NOTHING, rather than falling back to a CLI nobody picked", async () => {
    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, engine: "gemini" });

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/gemini/);
    expect(res.error).toMatch(/claude/);
    expect(res.error).toMatch(/agy/);
    expect(mockIssuesCreate).not.toHaveBeenCalled();
  });

  it("advertises the engine in its input schema, as an optional enum", () => {
    const schema = dispatchAntigravityTool.input_schema;
    const props = schema?.properties as Record<string, { enum?: string[] }>;
    expect(props["engine"]?.enum).toEqual(["agy", "claude"]);
    expect(schema?.required).not.toContain("engine");
  });

  it("starts the run for the issue it just filed (build stage for agent:ready)", async () => {
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    await dispatchAntigravityTool.execute({ ...COMPLETE });

    expect(mockStartDispatchJob).toHaveBeenCalledWith(524, "pushkarverma3698/FounderOS", "build");
  });

  it("tells the founder in the reply when the run could not start: success, plus a warning", async () => {
    mockIssuesCreate.mockResolvedValueOnce({ data: { ...issueCreated(), number: 525 } });
    mockStartDispatchJob.mockResolvedValueOnce({ status: "failed", reason: "connect ENOENT /run/fos-job.sock" });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE });

    expect(res.success).toBe(true);
    expect((res.data as { issue_number: number }).issue_number).toBe(525);
    expect((res.data as { warnings: string[] }).warnings.join("\n")).toContain("could not start pushkarverma3698/FounderOS#525: connect ENOENT /run/fos-job.sock");
  });

  it("surfaces GitHub API errors cleanly without crashing", async () => {
    mockIssuesCreate.mockRejectedValueOnce(new Error("Resource protected by organization SAML"));

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE });

    expect(res.success).toBe(false);
    expect(res.error).toContain("GitHub issue creation failed: Resource protected by organization SAML");
  });
});

describe("dispatchAntigravityTool.execute — the brief lint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadDefaultEngine.mockReturnValue("agy");
    resetBriefCheckMemo();
    process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
    mockGetContent.mockResolvedValue({ data: {} });
    mockRepoGet.mockResolvedValue({ data: {} });
  });

  it("files NOTHING for a brief with a missing section, and says what to fix; a path that does not exist is not what stops it", async () => {
    githubHas(); // not on beta either
    const res = await dispatchAntigravityTool.execute({
      ...COMPLETE,
      scope: "src/agents/supervisor.ts, src/tools/index.ts",
      evidence: "",
    });

    expect(res.success).toBe(false);
    expect(mockIssuesCreate).not.toHaveBeenCalled();
    expect(mockStartDispatchJob).not.toHaveBeenCalled();
    expect(res.error).toContain("nothing was filed on pushkarverma3698/FounderOS");
    expect(res.error).toContain('1. Section "## Evidence" is empty');
    expect(res.error).toContain("Pass it in the `evidence` input.");
    expect(res.error).toContain("`founder_request`");
    // the missing path was demoted, so it is no longer a problem to fix
    expect(res.error).not.toContain("does not exist in pushkarverma3698/FounderOS");
    expect(res.data).toMatchObject({ missing_headings: ["Evidence"], missing_paths: [] });
  });

  it("still rejects issue #762's two empty sections, and no longer calls its three invented files a defect to fix", async () => {
    // #762's own text: no problem statement, no evidence, three files that never existed. The sections are
    // what a founder-facing rejection can ask for; a file only Antigravity can find is demoted to a hint.
    githubHas(); // nor on beta
    const res = await dispatchAntigravityTool.execute({
      title: "feat: Jev AI System 1 gateway",
      goal: "Integrate Jev AI as a System 1 deterministic gateway and RAG pre-filter across FounderOS routing, memory retrieval, and tool validation systems.",
      scope: "src/agents/supervisor.ts, src/tools/brain.ts, src/tools/index.ts, src/services/jev-ai.ts",
      expected: "In `src/agents/supervisor.ts`: Integrate Jev AI gateway. In `src/tools/brain.ts`: Integrate Jev AI context pre-filtering.",
      verification: "pnpm test && pnpm gate",
      forbidden: "Do not break existing test suites.",
    });

    expect(res.success).toBe(false);
    expect(mockIssuesCreate).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ missing_headings: ["Problem / observed behavior", "Evidence"], missing_paths: [] });
  });

  it("with the sections filled, #762's invented files are filed as labelled hints: the executor is told they are guesses", async () => {
    githubHas(); // nor on beta
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });
    const res = await dispatchAntigravityTool.execute({
      title: "feat: Jev AI System 1 gateway",
      goal: "Integrate Jev AI as a System 1 deterministic gateway across FounderOS routing.",
      problem: "There is no gateway in front of the router.",
      evidence: "The founder's request of 2026-09-27.",
      scope: "src/agents/supervisor.ts, src/tools/brain.ts, src/tools/index.ts",
      expected: "In `src/agents/supervisor.ts`: Integrate Jev AI gateway.",
      verification: "pnpm test && pnpm gate",
    });

    expect(res.success).toBe(true);
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(filed).toContain("They are guesses, not facts");
    // src/tools/index.ts exists in the checkout, so it stays a verified fact; the two invented files are hints
    expect(filed).toContain("```text\n1. src/agents/supervisor.ts\n2. src/tools/brain.ts\n```");
    expect(filed).toContain("src/tools/index.ts");
    expect(filed).toContain("src/agents/supervisor.ts (unverified): Integrate Jev AI gateway.");
    expect((res.data as { warnings: string[] }).warnings[0]).toMatch(/^Not found in the repository, so filed as unverified hints, not facts: src\/agents\/supervisor\.ts, src\/tools\/brain\.ts\./);
    expect(mockStartDispatchJob).toHaveBeenCalledTimes(1);
  });

  it("turns the founder's own words into the Evidence when none was given, and never overrides evidence that was", async () => {
    mockIssuesCreate.mockResolvedValue({ data: issueCreated() });
    await dispatchAntigravityTool.execute({ ...COMPLETE, evidence: "", founder_request: "add a footer to the login page\nwith the version" });
    const first = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(first).toContain("The founder's request, verbatim:\n\n> add a footer to the login page\n> with the version");
    expect(first).toContain("Nothing else came with it");

    await dispatchAntigravityTool.execute({ ...COMPLETE, evidence: "log line: 500 at 12:01", founder_request: "add a footer" });
    const second = (mockIssuesCreate.mock.calls[1]?.[0] as { body: string }).body;
    expect(second).toContain("log line: 500 at 12:01");
    expect(second).not.toContain("verbatim");
  });

  it("files NOTHING for a brief over GitHub's size limit, and says so before any approval is spent", async () => {
    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, expected: "requirement ".repeat(7000) });

    expect(res.success).toBe(false);
    expect(mockIssuesCreate).not.toHaveBeenCalled();
    expect(res.error).toContain("1. The brief is");
    expect(res.error).toContain("65,536");
  });

  it("accepts a file the task will create when it is passed as new_files", async () => {
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, new_files: "src/tools/rate-limiter-new.ts" });

    expect(res.success).toBe(true);
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(filed).toContain("### New files to create\n\nsrc/tools/rate-limiter-new.ts");
  });

  it("accepts a FounderOS file that exists only on beta: the executor branches from beta, prod is on main", async () => {
    githubHas("src/tools/only-on-beta.ts");
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, scope: "src/tools/only-on-beta.ts" });

    expect(res.success).toBe(true);
    expect(mockGetContent).toHaveBeenCalledWith(expect.objectContaining({ path: "src/tools/only-on-beta.ts", ref: "beta" }));
  });

  it("asks GitHub about another repo's paths, and a definite 404 is demoted to a hint: the issue is still filed", async () => {
    mockGetContent.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, repo: OPLIFY, scope: "src/gone.ts" });

    expect(mockGetContent).toHaveBeenCalledWith(expect.objectContaining({ owner: "OplifyMessage", repo: "oplify-messaging-api", path: "src/gone.ts" }));
    expect(res.success).toBe(true);
    const filed = (mockIssuesCreate.mock.calls[0]?.[0] as { body: string }).body;
    expect(filed).toContain("```text\n1. src/gone.ts\n```");
    expect((res.data as { warnings: string[] }).warnings[0]).toContain("src/gone.ts");
  });

  it("files the issue, and reports what it could not check, when GitHub is down", async () => {
    // The loop's job is not to block on its own infrastructure: only a definite 404 fails.
    mockGetContent.mockRejectedValue(Object.assign(new Error("Service Unavailable"), { status: 503 }));
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const res = await dispatchAntigravityTool.execute({ ...COMPLETE, repo: OPLIFY, scope: "src/app.ts" });

    expect(res.success).toBe(true);
    expect(mockIssuesCreate).toHaveBeenCalledTimes(1);
    const warnings = (res.data as { warnings: string[] }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not verify 1 of 1 path");
    expect(warnings[0]).toContain("Service Unavailable");
  });

  it("shares one set of GitHub lookups between the pre-approval lint and execute()", async () => {
    // agent-tools/antigravity.ts lints before the approval card; execute() lints again.
    const input = { ...COMPLETE, repo: OPLIFY, scope: "src/app.ts, src/api.ts" };
    const body = formatAntigravityIssueBody(input);
    mockIssuesCreate.mockResolvedValueOnce({ data: issueCreated() });

    const before = await lintDispatchBrief({ owner: "OplifyMessage", repo: "oplify-messaging-api" }, body);
    expect(before.ok).toBe(true);
    expect(mockGetContent).toHaveBeenCalledTimes(2);

    await dispatchAntigravityTool.execute(input);
    expect(mockGetContent).toHaveBeenCalledTimes(2);
    expect(mockIssuesCreate).toHaveBeenCalledTimes(1);
  });
});

describe("describeBriefRejection", () => {
  it("names the input that fills each section, so the model can fix the call", async () => {
    const lint = await lintAgentBrief(formatAntigravityIssueBody({ ...COMPLETE, evidence: undefined, problem: undefined }), () => true);
    const text = describeBriefRejection(lint, "o/r");

    expect(text).toContain('Section "## Problem / observed behavior" is empty (only whitespace or an HTML comment). Pass it in the `problem` input');
    expect(text).toContain('Section "## Evidence" is empty (only whitespace or an HTML comment). Pass it in the `evidence` input.');
    expect(text).toContain("`founder_request`");
  });
});

describe("DEFAULT_DISPATCH_REPO", () => {
  it("is re-exported for existing importers", () => {
    expect(DEFAULT_DISPATCH_REPO).toBe("pushkarverma3698/FounderOS");
  });
});
