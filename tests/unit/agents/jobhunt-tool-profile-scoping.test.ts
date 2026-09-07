/**
 * Unit tests — every jobhunt agent-tool wrapper's `profile` argument
 * (src/agents/agent-tools/jobhunt.ts).
 *
 * 2026-09-07: of the eight jobhunt tools exposed to free-text chat, five
 * either had no way to say which candidate they were about (screen_job,
 * review_screened, job_brief) or had one at the underlying UnifiedTool layer
 * that this wrapper never exposed to the model (tailor_cv, cv_gaps) — so a
 * free-text question naming the second candidate silently ran against the
 * founder's own queue, or against a query with no profile filter at all,
 * mixing both. Root-caused from a real production chat: "Give Tashi's fresh
 * jobs" returned a tech role (Amadeus) that belongs to the other profile.
 *
 * These pin: an unrecognised profile name refuses loudly rather than
 * guessing (same rule jobhunt-profile-arg.ts already applies to slash
 * commands), a known alias/first-name resolves to the registered id, and
 * every wrapper forwards the resolved id to its underlying tool.
 */

import { describe, it, expect, vi } from "vitest";

const mockScreenJobExecute = vi.fn(async () => ({ success: true as const, data: "screened" }));
vi.mock("../../../src/tools/jobhunt/screen.js", () => ({
  screenJobTool: { description: "mock screen_job", execute: mockScreenJobExecute },
}));

const mockTailorCvExecute = vi.fn(async () => ({ success: true as const, data: "tailored" }));
vi.mock("../../../src/tools/jobhunt/tailor-tool.js", () => ({
  tailorCvTool: { description: "mock tailor_cv", execute: mockTailorCvExecute },
}));

const mockReviewScreenedExecute = vi.fn(async () => ({ success: true as const, data: "reviewed" }));
vi.mock("../../../src/tools/jobhunt/review.js", () => ({
  reviewScreenedTool: { description: "mock review_screened", execute: mockReviewScreenedExecute },
}));

const mockCvGapsExecute = vi.fn(async () => ({ success: true as const, data: "gaps" }));
vi.mock("../../../src/tools/jobhunt/gaps.js", () => ({
  cvGapsTool: { description: "mock cv_gaps", execute: mockCvGapsExecute },
}));

const mockJobBriefExecute = vi.fn(async () => ({ success: true as const, data: "brief" }));
vi.mock("../../../src/tools/jobhunt/daily-brief.js", () => ({
  jobBriefTool: { description: "mock job_brief", execute: mockJobBriefExecute },
}));

vi.mock("../../../src/tools/career.js", () => ({
  readCvTool: { description: "mock read_cv", execute: vi.fn() },
  searchJobsTool: { description: "mock search_jobs", execute: vi.fn() },
}));
vi.mock("../../../src/tools/jobhunt/ingest-tool.js", () => ({
  ingestJobsTool: { description: "mock ingest_jobs", execute: vi.fn() },
}));

const { screenJob, tailorCvForRow, reviewScreened, cvGaps, jobBrief } = await import(
  "../../../src/agents/agent-tools/jobhunt.js"
);

const SCREEN_ARGS = {
  company: "Acme",
  title: "Financial Analyst",
  description: "A".repeat(50),
};

describe("jobhunt agent-tool wrappers — profile argument", () => {
  it("screen_job forwards a resolved profileId to screenJobTool", async () => {
    mockScreenJobExecute.mockClear();
    await screenJob.invoke({ ...SCREEN_ARGS, profile: "wife-nl-finance" });
    expect(mockScreenJobExecute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });

  it("screen_job resolves a first-name alias, case-insensitively", async () => {
    mockScreenJobExecute.mockClear();
    await screenJob.invoke({ ...SCREEN_ARGS, profile: "Tashi" });
    expect(mockScreenJobExecute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });

  it("screen_job omits profileId entirely when no profile is named — underlying tool defaults, never a mix", async () => {
    mockScreenJobExecute.mockClear();
    await screenJob.invoke(SCREEN_ARGS);
    expect(mockScreenJobExecute).toHaveBeenCalledWith(
      expect.not.objectContaining({ profileId: expect.anything() }),
    );
  });

  it("screen_job refuses an unrecognised profile loudly instead of guessing", async () => {
    mockScreenJobExecute.mockClear();
    const res = await screenJob.invoke({ ...SCREEN_ARGS, profile: "someone-unregistered" });
    expect(res).toContain("someone-unregistered");
    expect(res).toContain("wife-nl-finance");
    expect(mockScreenJobExecute).not.toHaveBeenCalled();
  });

  it("tailor_cv forwards a resolved profileId — both candidates number their brief from 1", async () => {
    mockTailorCvExecute.mockClear();
    await tailorCvForRow.invoke({ rank: 3, profile: "wife-nl-finance" });
    expect(mockTailorCvExecute).toHaveBeenCalledWith(
      expect.objectContaining({ rank: 3, profileId: "wife-nl-finance" }),
    );
  });

  it("review_screened forwards a resolved profileId — was the tool that returned a global mixed total in prod", async () => {
    mockReviewScreenedExecute.mockClear();
    await reviewScreened.invoke({ profile: "wife-nl-finance" });
    expect(mockReviewScreenedExecute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });

  it("cv_gaps forwards the resolved id under its own tool's existing arg key, 'profile'", async () => {
    mockCvGapsExecute.mockClear();
    await cvGaps.invoke({ profile: "wife-nl-finance" });
    expect(mockCvGapsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "wife-nl-finance" }),
    );
  });

  it("job_brief forwards a resolved profileId — the ranked shortlist itself was Pushkar-only from free text", async () => {
    mockJobBriefExecute.mockClear();
    await jobBrief.invoke({ profile: "wife-nl-finance" });
    expect(mockJobBriefExecute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance" }),
    );
  });
});
