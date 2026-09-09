/**
 * Unit tests for the Antigravity dispatch tool.
 * Mocks Octokit — runs offline at $0 cost with no live API calls or real tokens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockIssuesCreate = vi.fn();
const mockKickDispatchTick = vi.fn();

vi.mock("octokit", () => {
  return {
    Octokit: vi.fn().mockImplementation(() => ({
      rest: {
        issues: { create: mockIssuesCreate },
      },
    })),
  };
});

vi.mock("../../../src/tools/dispatch-tick.js", () => ({
  kickDispatchTick: mockKickDispatchTick,
}));

const {
  dispatchAntigravityTool,
  formatAntigravityIssueBody,
  resolveDispatchRepo,
  DEFAULT_DISPATCH_REPO,
  AGENT_READY_LABEL,
  ANTIGRAVITY_LABEL,
} = await import("../../../src/tools/dispatch-antigravity.js");

describe("formatAntigravityIssueBody", () => {
  it("formats all required sections conforming to agent-task.md", () => {
    const body = formatAntigravityIssueBody({
      title: "feat: 13k ATS scaling",
      goal: "Scale free ATS ingestion to sweep 13,000 boards within 30 minutes.",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Implement per-domain token-bucket rate limiter and ETag conditional GET caching.",
      verification: "pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate",
      acceptance: "Green tests and ETag 304 responses skip re-downloading.",
      forbidden: "Do not touch metered scraping endpoints.",
      evidence: "Observed 429 rate limit triggers on SmartRecruiters and Greenhouse.",
    });

    expect(body).toContain("## Goal\n\nScale free ATS ingestion");
    expect(body).toContain("## Problem / observed behavior\n\nObserved 429 rate limit triggers");
    expect(body).toContain("## Expected behavior\n\nImplement per-domain token-bucket");
    expect(body).toContain("## Files or subsystem in scope\n\nsrc/tools/jobhunt/free-ats-source.ts");
    expect(body).toContain("## Explicitly forbidden\n\nDo not touch metered scraping endpoints.");
    expect(body).toContain("## Verification commands\n\npnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate");
    expect(body).toContain("## Acceptance criteria\n\nGreen tests and ETag 304 responses skip re-downloading.");
  });

  it("applies sensible defaults for optional fields", () => {
    const body = formatAntigravityIssueBody({
      title: "fix: token bucket",
      goal: "Fix bucket leak",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Leak fixed",
      verification: "pnpm test",
    });

    expect(body).toContain("## Explicitly forbidden\n\nSee docs/antigravity/STANDARDS.md");
    expect(body).toContain("## Acceptance criteria\n\nAll verification commands pass; Claude pr-brain clears review with no BLOCKER.");
    expect(body).toContain("## Problem / observed behavior\n\nTask dispatched by Founder via FounderOS.");
  });
});

describe("resolveDispatchRepo", () => {
  it("uses provided repo argument when it is on the allowlist", () => {
    expect(resolveDispatchRepo("pushkarverma3698/House-of-Hulda-Website-frontend")).toEqual({
      owner: "pushkarverma3698",
      repo: "House-of-Hulda-Website-frontend",
    });
  });

  it("refuses a caller-supplied repo that is not on the allowlist", () => {
    // `repo` is model-supplied and takes precedence over every env var, so this is the
    // one path between a malformed instruction and any repo the token can write to.
    expect(() => resolveDispatchRepo("custom-owner/custom-repo")).toThrow(
      /not on the Antigravity dispatch allowlist/,
    );
  });

  it("falls back to DEFAULT_DISPATCH_REPO when no argument or env var is set", () => {
    const orig = process.env["ISSUE_REPO"];
    delete process.env["ISSUE_REPO"];
    delete process.env["SELF_IMPROVE_ISSUE_REPO"];
    try {
      expect(resolveDispatchRepo()).toEqual({
        owner: "pushkarverma3698",
        repo: "FounderOS",
      });
    } finally {
      if (orig) process.env["ISSUE_REPO"] = orig;
    }
  });

  it("treats ISSUE_REPO as a target, not a bypass", () => {
    // The VPS crontab sets ISSUE_REPO. If that box is ever misconfigured, dispatch must
    // fail loudly rather than quietly file issues somewhere unwatched.
    const orig = process.env["ISSUE_REPO"];
    process.env["ISSUE_REPO"] = "someone-else/somewhere";
    delete process.env["SELF_IMPROVE_ISSUE_REPO"];
    try {
      expect(() => resolveDispatchRepo()).toThrow(/not on the Antigravity dispatch allowlist/);
    } finally {
      if (orig) process.env["ISSUE_REPO"] = orig;
      else delete process.env["ISSUE_REPO"];
    }
  });

  it("throws error for malformed slug", () => {
    expect(() => resolveDispatchRepo("invalid-slug-without-slash")).toThrow(/Invalid repository slug/);
  });
});

describe("dispatchAntigravityTool.execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env["GITHUB_TOKEN"] = "ghp_mock_token_for_tests";
  });

  it("rejects if required fields are missing", async () => {
    const res = await dispatchAntigravityTool.execute({
      title: "Incomplete task",
      goal: "Only goal provided",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("dispatch_antigravity_task requires title, goal, scope, expected, and verification");
  });

  it("returns error if GITHUB_TOKEN is missing", async () => {
    delete process.env["GITHUB_TOKEN"];
    const res = await dispatchAntigravityTool.execute({
      title: "feat: task",
      goal: "goal",
      scope: "src/tools/free-ats.ts",
      expected: "expected",
      verification: "pnpm test",
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain("GITHUB_TOKEN not configured");
  });

  it("creates issue with agent:ready and antigravity labels", async () => {
    mockIssuesCreate.mockResolvedValueOnce({
      data: {
        number: 524,
        html_url: "https://github.com/pushkarverma3698/FounderOS/issues/524",
        title: "feat: 13k ATS scaling with per-domain rate limiting",
      },
    });

    const res = await dispatchAntigravityTool.execute({
      title: "feat: 13k ATS scaling with per-domain rate limiting",
      goal: "Implement per-domain token bucket rate limiting",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Replace global concurrency with domain rate limits",
      verification: "pnpm test tests/unit/tools/free-ats-source.test.ts",
    });

    expect(res.success).toBe(true);
    expect(mockIssuesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "pushkarverma3698",
        repo: "FounderOS",
        title: "feat: 13k ATS scaling with per-domain rate limiting",
        labels: [AGENT_READY_LABEL, ANTIGRAVITY_LABEL],
      }),
    );

    const data = res.data as { issue_number: number; issue_url: string; repo: string };
    expect(data.issue_number).toBe(524);
    expect(data.issue_url).toBe("https://github.com/pushkarverma3698/FounderOS/issues/524");
    expect(data.repo).toBe("pushkarverma3698/FounderOS");
  });

  it("kicks the dispatcher for the issue it just filed", async () => {
    // Without the kick the founder waits up to 15 minutes for the next cron tick with
    // no visible sign anything happened.
    mockIssuesCreate.mockResolvedValueOnce({
      data: {
        number: 524,
        html_url: "https://github.com/pushkarverma3698/FounderOS/issues/524",
        title: "feat: task",
      },
    });

    await dispatchAntigravityTool.execute({
      title: "feat: task",
      goal: "goal",
      scope: "src/tools/free-ats.ts",
      expected: "expected",
      verification: "pnpm test",
    });

    expect(mockKickDispatchTick).toHaveBeenCalledWith(524);
  });

  it("still reports success when the kick fails — cron is the guaranteed path", async () => {
    mockIssuesCreate.mockResolvedValueOnce({
      data: {
        number: 525,
        html_url: "https://github.com/pushkarverma3698/FounderOS/issues/525",
        title: "feat: task",
      },
    });
    mockKickDispatchTick.mockImplementationOnce(() => {
      throw new Error("spawn EACCES");
    });

    const res = await dispatchAntigravityTool.execute({
      title: "feat: task",
      goal: "goal",
      scope: "src/tools/free-ats.ts",
      expected: "expected",
      verification: "pnpm test",
    });

    expect(res.success).toBe(true);
    expect((res.data as { issue_number: number }).issue_number).toBe(525);
  });

  it("surfaces GitHub API errors cleanly without crashing", async () => {
    mockIssuesCreate.mockRejectedValueOnce(new Error("Resource protected by organization SAML"));

    const res = await dispatchAntigravityTool.execute({
      title: "feat: task",
      goal: "goal",
      scope: "src/tools/free-ats.ts",
      expected: "expected",
      verification: "pnpm test",
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("GitHub issue creation failed: Resource protected by organization SAML");
  });
});
