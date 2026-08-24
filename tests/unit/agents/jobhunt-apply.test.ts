/**
 * Regression test — submit_application must never click Submit before the
 * founder approves.
 *
 * Found live, 2026-08-24: the pre-gate pass (which exists only to refill the
 * form for the approval card's field count) called `submitApplyFlow` — the
 * SAME function that clicks the real Submit button — instead of the
 * side-effect-free `previewApplyFlow`. A live `/apply 12` against a real
 * Greenhouse posting (gitlab, job_id b87ad902-...) proved it: the server log
 * showed "Submit attempted, clicked:true" before the HITL card had even been
 * tapped. Rejecting the card afterward told the founder "Not submitted" —
 * false, since the click had already fired. Approving it would have clicked
 * Submit a SECOND time. This test pins the fix: previewApplyFlow (no click)
 * runs before the gate, submitApplyFlow (clicks) runs only after approval.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInterrupt = vi.fn();
vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: mockInterrupt };
});

vi.mock("../../../src/db/queries.js", () => ({
  createInterrupt: vi.fn().mockResolvedValue("test-interrupt-id"),
  getPendingInterrupt: vi.fn().mockResolvedValue(null),
  writeAuditEntry: vi.fn().mockResolvedValue(undefined),
}));

const ROW = {
  id: "b87ad902-eddb-4a2c-b7cd-6ca877f674c7",
  company: "gitlab",
  title: "Senior Backend Engineer",
  stage: "screened",
  url: "https://job-boards.greenhouse.io/gitlab/jobs/8716271002",
  brief_rank: 12,
};

const mockGetApplicationById = vi.fn().mockResolvedValue(ROW);
const mockUpdateApplicationStage = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/db/job-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
  updateApplicationStage: (...args: unknown[]) => mockUpdateApplicationStage(...args),
}));

vi.mock("../../../src/tools/jobhunt/apply-profile.js", () => ({
  readApplyProfile: vi.fn().mockResolvedValue({ ok: true, profile: { first_name: "Test" } }),
}));

const mockDownloadFile = vi.fn();
vi.mock("../../../src/infra/storage/s3-client.js", () => ({
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
}));

const previewResult = {
  ok: true as const,
  ats: "greenhouse" as const,
  summary: { filled: 8, total: 26, unanswered: ["Country*", "Attach"] },
  unansweredQuestions: ["Country*", "Attach"],
  screenshotPng: Buffer.from(""),
};

const mockPreviewApplyFlow = vi.fn();
const mockSubmitApplyFlow = vi.fn();
vi.mock("../../../src/tools/jobhunt/apply-headless.js", () => ({
  previewApplyFlow: (...args: unknown[]) => mockPreviewApplyFlow(...args),
  submitApplyFlow: (...args: unknown[]) => mockSubmitApplyFlow(...args),
}));

const { submitApplication } = await import("../../../src/agents/agent-tools/jobhunt-apply.js");

const CONFIG = { configurable: { thread_id: "turicks:1" } };

describe("submit_application — click ordering around the HITL gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApplicationById.mockResolvedValue(ROW);
    mockDownloadFile.mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    mockPreviewApplyFlow.mockResolvedValue(previewResult);
    mockSubmitApplyFlow.mockResolvedValue({
      ok: true,
      ats: "greenhouse",
      summary: previewResult.summary,
      unansweredQuestions: previewResult.unansweredQuestions,
      outcome: { clicked: true, confirmed: true, evidence: "URL changed" },
    });
  });

  it("on REJECT: previewApplyFlow ran for the card, submitApplyFlow (the click) never ran", async () => {
    mockInterrupt.mockReturnValue("rejected");

    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    expect(mockPreviewApplyFlow).toHaveBeenCalledTimes(1);
    expect(mockSubmitApplyFlow).not.toHaveBeenCalled();
    expect(mockUpdateApplicationStage).not.toHaveBeenCalled();
    expect(String(result)).toContain("Not submitted");
  });

  it("on APPROVE: previewApplyFlow (no click) ran before submitApplyFlow (the click) — never the reverse", async () => {
    mockInterrupt.mockReturnValue("approved");
    const callOrder: string[] = [];
    mockPreviewApplyFlow.mockImplementation(async () => {
      callOrder.push("preview");
      return previewResult;
    });
    mockSubmitApplyFlow.mockImplementation(async () => {
      callOrder.push("submit");
      return {
        ok: true,
        ats: "greenhouse",
        summary: previewResult.summary,
        unansweredQuestions: previewResult.unansweredQuestions,
        outcome: { clicked: true, confirmed: true, evidence: "URL changed" },
      };
    });

    await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    expect(callOrder).toEqual(["preview", "submit"]);
    expect(mockSubmitApplyFlow).toHaveBeenCalledTimes(1);
  });

  it("the pre-gate call never reaches the real Submit button — asserted against the driver directly", async () => {
    // previewApplyFlow's own contract (apply-headless.ts) never calls
    // clickSubmitAndVerify; this pins that the TOOL calls previewApplyFlow
    // (not submitApplyFlow) for its pre-gate pass, regardless of decision.
    mockInterrupt.mockReturnValue("rejected");
    await submitApplication.invoke({ job_id: ROW.id }, CONFIG);
    expect(mockPreviewApplyFlow).toHaveBeenCalledWith(ROW.url, expect.anything(), expect.anything());
    expect(mockSubmitApplyFlow).not.toHaveBeenCalled();
  });

  it("approved + confirmed: marks the row applied and reports success", async () => {
    mockInterrupt.mockReturnValue("approved");
    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);
    expect(mockUpdateApplicationStage).toHaveBeenCalledWith(
      ROW.id,
      "applied",
      expect.objectContaining({ clearBriefRank: true }),
    );
    expect(String(result)).toContain("✅ Submitted");
  });

  it("approved + clicked but unconfirmed: does NOT mark the row applied", async () => {
    mockInterrupt.mockReturnValue("approved");
    mockSubmitApplyFlow.mockResolvedValue({
      ok: true,
      ats: "greenhouse",
      summary: previewResult.summary,
      unansweredQuestions: previewResult.unansweredQuestions,
      outcome: { clicked: true, confirmed: false, evidence: "no confirmation signal within 15s" },
    });

    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    expect(mockUpdateApplicationStage).not.toHaveBeenCalled();
    expect(String(result)).toContain("could not confirm");
  });

  it("already-applied rows are refused before any browser work happens", async () => {
    mockGetApplicationById.mockResolvedValue({ ...ROW, stage: "applied" });
    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);
    expect(mockPreviewApplyFlow).not.toHaveBeenCalled();
    expect(mockSubmitApplyFlow).not.toHaveBeenCalled();
    expect(String(result)).toContain("already marked applied");
  });
});

describe("submit_application — resume attachment", () => {
  // Found live, 2026-08-24: both fill passes ran with an empty RowFacts
  // ({}), so the resume field always fell to "ask" — every real submission
  // would have gone out with no resume, on every platform, even though
  // /apply N's own first preview (a separate call, with the freshly-rendered
  // local path still in scope) attached one correctly. The tailored CV was
  // never missing — apply-packet.ts already persists it to S3 via
  // recordTailoringResult's tailoredCvS3Key; this tool just never read it
  // back to re-attach it for its OWN fill passes.
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetApplicationById.mockResolvedValue({ ...ROW, tailored_cv_s3_key: "ready-applications/2026-08-24/altura/x_tailored_cv.pdf" });
    mockDownloadFile.mockResolvedValue(Buffer.from("fake-pdf-bytes"));
    mockPreviewApplyFlow.mockResolvedValue(previewResult);
    mockSubmitApplyFlow.mockResolvedValue({
      ok: true,
      ats: "greenhouse",
      summary: previewResult.summary,
      unansweredQuestions: previewResult.unansweredQuestions,
      outcome: { clicked: true, confirmed: true, evidence: "URL changed" },
    });
  });

  it("downloads the tailored CV from S3 and threads a real local path into both fill passes", async () => {
    mockInterrupt.mockReturnValue("approved");
    await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    expect(mockDownloadFile).toHaveBeenCalledWith("ready-applications/2026-08-24/altura/x_tailored_cv.pdf");
    expect(mockDownloadFile).toHaveBeenCalledTimes(2); // once pre-gate, once post-approval — no cached path carried across the HITL wait

    const [, , previewRow] = mockPreviewApplyFlow.mock.calls[0] as [unknown, unknown, { resumePath?: string }];
    const [, , submitRow] = mockSubmitApplyFlow.mock.calls[0] as [unknown, unknown, { resumePath?: string }];
    expect(previewRow.resumePath).toMatch(/resume-.*\.pdf$/);
    expect(submitRow.resumePath).toMatch(/resume-.*\.pdf$/);
  });

  it("a row with no tailored CV on file submits with resumePath undefined, never crashes", async () => {
    mockGetApplicationById.mockResolvedValue({ ...ROW, tailored_cv_s3_key: null });
    mockInterrupt.mockReturnValue("rejected");

    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    expect(mockDownloadFile).not.toHaveBeenCalled();
    const [, , previewRow] = mockPreviewApplyFlow.mock.calls[0] as [unknown, unknown, { resumePath?: string }];
    expect(previewRow.resumePath).toBeUndefined();
    expect(String(result)).toContain("Not submitted");
  });

  it("an S3 download failure falls back to no resume rather than failing the whole submission", async () => {
    mockDownloadFile.mockRejectedValue(new Error("NoSuchKey"));
    mockInterrupt.mockReturnValue("rejected");

    const result = await submitApplication.invoke({ job_id: ROW.id }, CONFIG);

    const [, , previewRow] = mockPreviewApplyFlow.mock.calls[0] as [unknown, unknown, { resumePath?: string }];
    expect(previewRow.resumePath).toBeUndefined();
    expect(String(result)).toContain("Not submitted"); // did not throw — degraded gracefully
  });
});
