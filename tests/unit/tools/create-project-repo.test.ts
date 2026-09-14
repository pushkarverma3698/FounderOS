/**
 * Unit tests — starting a new project repo from Telegram.
 *
 * Two properties matter here and they pull in opposite directions.
 *
 * The FEATURE is that a repo created this way becomes dispatchable immediately: the
 * founder is on a train, says "start a new project for the pricing API", and the agent
 * loop can work in it without a code change and a deploy.
 *
 * The BOUNDARY is that this must not become a way for a model to nominate an arbitrary
 * repository. So creation is what grants access, and creation happens under the
 * founder's own account behind an approval card. The registry write therefore has to
 * be strictly downstream of a CONFIRMED create — a name that failed to be created must
 * never end up dispatchable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGithubExecute = vi.fn();
const mockRegisterDispatchRepo = vi.fn();
const mockHasBeenAudited = vi.fn();

vi.mock("../../../src/tools/github.js", () => ({
  githubTool: { execute: mockGithubExecute },
}));

vi.mock("../../../src/db/queries.js", () => ({
  registerDispatchRepo: mockRegisterDispatchRepo,
  hasBeenAudited: mockHasBeenAudited,
}));

const { validateProjectRepoName, createProjectRepoTool } = await import(
  "../../../src/tools/create-project-repo.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockHasBeenAudited.mockResolvedValue(false);
  mockRegisterDispatchRepo.mockResolvedValue({ written: true });
});

describe("validateProjectRepoName", () => {
  it("accepts an ordinary kebab-case project name", () => {
    expect(validateProjectRepoName("turicks-pricing-api")).toBeNull();
  });

  it("accepts dots, underscores and digits — all legal on GitHub", () => {
    expect(validateProjectRepoName("naggar_v2.1")).toBeNull();
  });

  it("rejects an empty name", () => {
    expect(validateProjectRepoName("   ")).toMatch(/name/i);
  });

  it("rejects a name containing a slash, which would read as owner/repo", () => {
    // Without this, "someone-else/thing" would silently become
    // "pushkarverma3698/someone-else/thing" or worse.
    expect(validateProjectRepoName("someone-else/thing")).toMatch(/slash/i);
  });

  it("rejects spaces rather than silently slugifying them", () => {
    // GitHub would accept "my project" by converting it to "my-project", so the repo
    // that gets created has a different name from the one that gets registered.
    expect(validateProjectRepoName("my project")).toMatch(/space/i);
  });

  it("rejects characters GitHub would rewrite", () => {
    expect(validateProjectRepoName("proj#1")).not.toBeNull();
    expect(validateProjectRepoName("../etc")).not.toBeNull();
  });

  it("rejects a name longer than GitHub's 100-character limit", () => {
    expect(validateProjectRepoName("a".repeat(101))).toMatch(/100/);
  });

  it("rejects a name that collides with a repo already on the hardcoded allowlist", () => {
    // Creating this would fail at GitHub anyway, but the useful message is ours.
    expect(validateProjectRepoName("FounderOS")).toMatch(/already/i);
  });
});

describe("create_project_repo — execute", () => {
  const ARGS = { name: "turicks-pricing-api", description: "Pricing API" };

  it("creates the repo, then registers it as dispatchable", async () => {
    mockGithubExecute.mockResolvedValue({
      success: true,
      data: {
        full_name: "pushkarverma3698/turicks-pricing-api",
        url: "https://github.com/pushkarverma3698/turicks-pricing-api",
        private: true,
      },
    });

    const result = await createProjectRepoTool.execute(ARGS);

    expect(result.success).toBe(true);
    expect(mockRegisterDispatchRepo).toHaveBeenCalledWith(
      "pushkarverma3698/turicks-pricing-api",
      expect.any(String),
    );
  });

  it("defaults to a PRIVATE repo", async () => {
    mockGithubExecute.mockResolvedValue({
      success: true,
      data: { full_name: "pushkarverma3698/x", url: "u", private: true },
    });

    await createProjectRepoTool.execute({ name: "x" });

    expect(mockGithubExecute).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_repo", private: "true" }),
    );
  });

  it("creates a public repo only when explicitly asked", async () => {
    mockGithubExecute.mockResolvedValue({
      success: true,
      data: { full_name: "pushkarverma3698/x", url: "u", private: false },
    });

    await createProjectRepoTool.execute({ name: "x", isPrivate: false });

    expect(mockGithubExecute).toHaveBeenCalledWith(
      expect.objectContaining({ private: "false" }),
    );
  });

  it("does NOT register anything when repo creation fails", async () => {
    // The whole security property: only a repo that demonstrably exists, created by
    // us, becomes dispatchable. A failed create that still registered the name would
    // let a later "someone else took that name" repo inherit our trust.
    mockGithubExecute.mockResolvedValue({ success: false, error: "name already exists" });

    const result = await createProjectRepoTool.execute(ARGS);

    expect(result.success).toBe(false);
    expect(mockRegisterDispatchRepo).not.toHaveBeenCalled();
  });

  it("does NOT register when GitHub returns success with no full_name (soft failure)", async () => {
    mockGithubExecute.mockResolvedValue({ success: true, data: { url: "u" } });

    const result = await createProjectRepoTool.execute(ARGS);

    expect(result.success).toBe(false);
    expect(mockRegisterDispatchRepo).not.toHaveBeenCalled();
  });

  it("refuses an invalid name without calling GitHub at all", async () => {
    const result = await createProjectRepoTool.execute({ name: "has spaces" });

    expect(result.success).toBe(false);
    expect(mockGithubExecute).not.toHaveBeenCalled();
  });

  it("never throws — a thrown Octokit error comes back as a typed failure", async () => {
    // TOOL-STANDARDS.md check 1: execute() must never throw.
    mockGithubExecute.mockRejectedValue(new Error("socket hang up"));

    const result = await createProjectRepoTool.execute(ARGS);

    expect(result.success).toBe(false);
    expect(result.error).toContain("socket hang up");
  });

  it("tells the founder what the VPS still needs before the loop can run there", async () => {
    // A repo that is dispatchable but has no workspace on the box produces an issue
    // nothing ever claims. Saying so here is the difference between a feature and a
    // silent dead end.
    mockGithubExecute.mockResolvedValue({
      success: true,
      data: { full_name: "pushkarverma3698/turicks-pricing-api", url: "u", private: true },
    });

    const result = await createProjectRepoTool.execute(ARGS);
    const data = result.data as { next_steps?: string };

    expect(data.next_steps).toMatch(/agy-workspace/);
    expect(data.next_steps).toMatch(/opt\/review/);
  });

  it("skips a duplicate create when the same name was already made", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await createProjectRepoTool.execute(ARGS);

    expect(result.success).toBe(true);
    expect(mockGithubExecute).not.toHaveBeenCalled();
  });
});
