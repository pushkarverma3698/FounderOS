/**
 * Unit tests — screen_job (DB mocked, real sponsor register).
 *
 * The gate exists to stop two expensive mistakes: drafting an application to a
 * company that cannot lawfully hire, and applying twice to the same role. Both
 * are asserted here against the REAL register, because a screen that passes only
 * against a fixture register proves nothing about the market it actually screens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFind = vi.fn(async (_key: string) => null as Record<string, unknown> | null);
const mockRecord = vi.fn(async (row: Record<string, unknown>) => ({ id: "ja1", ...row }));

vi.mock("../../../src/db/job-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, findApplicationByDedupeKey: mockFind, recordScreenedApplication: mockRecord };
});

const { screenJobTool, combineVerdict } = await import("../../../src/tools/jobhunt/screen.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue(null);
});

describe("combineVerdict", () => {
  it("passes only when every gate passes", () => {
    const v = combineVerdict([
      { gate: "Sponsor", status: "pass", evidence: "ok" },
      { gate: "Salary", status: "pass", evidence: "ok" },
    ]);
    expect(v.status).toBe("pass");
  });

  it("lets one reject absorb an otherwise clean screen", () => {
    // Arrange — a legally impossible hire that scores perfectly elsewhere.
    const gates = [
      { gate: "Sponsor", status: "reject" as const, evidence: "not on register" },
      { gate: "Salary", status: "pass" as const, evidence: "clears floor" },
    ];

    // Act
    const v = combineVerdict(gates);

    // Assert
    expect(v.status).toBe("reject");
  });

  it("flags rather than passes when any gate is unsettled", () => {
    const v = combineVerdict([
      { gate: "Sponsor", status: "pass", evidence: "ok" },
      { gate: "Salary", status: "flag", evidence: "no salary stated" },
    ]);
    expect(v.status).toBe("flag");
  });

  it("reports every gate's evidence, not just the deciding one", () => {
    const v = combineVerdict([
      { gate: "Sponsor", status: "reject", evidence: "absent" },
      { gate: "Language", status: "reject", evidence: "Dutch required" },
    ]);
    expect(v.reasons).toHaveLength(2);
    expect(v.reasons[1]).toContain("Dutch required");
  });
});

describe("screenJobTool.execute", () => {
  it("rejects a company that is absent from the IND register", async () => {
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      salary_max: 80_000,
    });

    expect(res.success).toBe(true);
    expect(res.data).toContain("REJECT");
    expect(res.data).toContain("recognised-sponsor register");
  });

  it("rejects a recognised sponsor advertising below the permit floor", async () => {
    // Arrange — Adyen is on the register; €40k is under the €52,284 criterion.
    // Act
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      salary_max: 40_000,
    });

    // Assert — the bar is legal, so this must be a reject and not a flag.
    expect(res.data).toContain("REJECT");
    expect(res.data).toContain("52284");
  });

  it("passes a recognised sponsor clearing the floor with no Dutch requirement", async () => {
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      salary_min: 70_000,
      salary_max: 90_000,
      description: "You will build agent systems. English is our working language.",
    });

    expect(res.data).toContain("PASS");
    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      sponsor_verdict: "sponsor",
      salary_status: "pass",
      stage: "screened",
    });
  });

  it("flags rather than rejects when no salary is stated", async () => {
    // Most Dutch postings state no salary; rejecting them would discard the market.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: "Great team, English-speaking.",
    });

    expect(res.data).toContain("NEEDS A HUMAN CHECK");
  });

  it("rejects a posting that genuinely requires Dutch fluency", async () => {
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      salary_max: 80_000,
      description: "Fluent Dutch is required for this role.",
    });

    expect(res.data).toContain("REJECT");
    expect(res.data).toContain("Dutch");
  });

  it("records the canonical register name when the sponsor gate matches exactly", async () => {
    await screenJobTool.execute({ company: "adyen nv", title: "AI Engineer", salary_max: 80_000 });

    expect(mockRecord.mock.calls[0]![0]).toMatchObject({ registered_name: "Adyen N.V." });
  });

  it("refuses to re-apply to a role already applied to, and writes nothing", async () => {
    // Arrange — the same role, applied to yesterday.
    mockFind.mockResolvedValue({
      id: "ja1",
      stage: "applied",
      applied_at: new Date(Date.now() - 86_400_000),
    });

    // Act
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      salary_max: 90_000,
    });

    // Assert — reported, not re-screened; no second row is created.
    expect(res.data).toContain("ALREADY IN PIPELINE");
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("allows re-screening a role applied to beyond the cooldown", async () => {
    mockFind.mockResolvedValue({
      id: "ja1",
      stage: "applied",
      applied_at: new Date(Date.now() - 200 * 86_400_000),
    });

    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      salary_max: 90_000,
    });

    expect(res.data).not.toContain("ALREADY IN PIPELINE");
    expect(mockRecord).toHaveBeenCalledOnce();
  });

  it("re-screens over a prior screened-but-not-applied row", async () => {
    mockFind.mockResolvedValue({ id: "ja1", stage: "screened", applied_at: null });

    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      salary_max: 90_000,
    });

    expect(res.data).toContain("PASS");
    expect(mockRecord).toHaveBeenCalledOnce();
  });

  it("fails loudly when the tracker is unreachable rather than screening blind", async () => {
    mockFind.mockRejectedValue(new Error("connection refused"));

    const res = await screenJobTool.execute({ company: "Adyen N.V.", title: "AI Engineer" });

    expect(res.success).toBe(false);
    expect(res.error).toContain("tracker unreachable");
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects empty input instead of writing a junk row", async () => {
    const res = await screenJobTool.execute({ company: "  ", title: "AI Engineer" });

    expect(res.success).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
