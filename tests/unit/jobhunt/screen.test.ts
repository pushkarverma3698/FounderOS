/**
 * Unit tests — screen_job (DB mocked, real sponsor register).
 *
 * The gate exists to stop three expensive mistakes: drafting an application to a
 * company that cannot lawfully hire, applying twice to the same role, and — the
 * silent one — rejecting a role that was actually fine. Asserted against the REAL
 * register, because a screen that only passes against a fixture proves nothing
 * about the market it screens.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFind = vi.fn(async (_key: string) => null as Record<string, unknown> | null);
const mockSoft = vi.fn(async (_soft: string, _exclude: string) => [] as Record<string, unknown>[]);
const mockRecord = vi.fn(async (row: Record<string, unknown>) => ({ id: "ja1", ...row }));

// screen.ts records CV signals on a PASS. Mocked so the unit suite never opens a
// database connection — a test that silently writes to a real table is a test
// that passes for the wrong reason.
vi.mock("../../../src/db/cv-signal-queries.js", () => ({
  recordSignals: vi.fn(async () => 0),
  listSignals: vi.fn(async () => []),
}));

vi.mock("../../../src/db/job-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    findApplicationByDedupeKey: mockFind,
    findApplicationsBySoftKey: mockSoft,
    recordScreenedApplication: mockRecord,
  };
});

const { screenJobTool, combineVerdict, routesToScreen, bestOutcome } = await import(
  "../../../src/tools/jobhunt/screen.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue(null);
  mockSoft.mockResolvedValue([]);
});

const ENGLISH_ONSITE = "On-site in Amsterdam. Visa sponsorship available. We work in English.";

describe("combineVerdict", () => {
  it("passes only when every gate passes", () => {
    expect(
      combineVerdict([
        { gate: "Sponsor", status: "pass", evidence: "ok" },
        { gate: "Salary", status: "pass", evidence: "ok" },
      ]).status,
    ).toBe("pass");
  });

  it("lets one reject absorb an otherwise clean screen", () => {
    expect(
      combineVerdict([
        { gate: "Sponsor", status: "reject", evidence: "not on register" },
        { gate: "Salary", status: "pass", evidence: "clears floor" },
      ]).status,
    ).toBe("reject");
  });

  it("flags rather than passes when any gate is unsettled", () => {
    expect(
      combineVerdict([
        { gate: "Sponsor", status: "pass", evidence: "ok" },
        { gate: "Salary", status: "flag", evidence: "no salary stated" },
      ]).status,
    ).toBe("flag");
  });
});

describe("routesToScreen", () => {
  it("screens an unclear posting under BOTH routes rather than guessing", () => {
    // Guessing wrong in either direction loses something, so both are screened.
    expect(routesToScreen("unclear")).toEqual(["hsm", "remote-contract"]);
  });

  it("screens a clearly-typed posting under one route only", () => {
    expect(routesToScreen("hsm")).toEqual(["hsm"]);
    expect(routesToScreen("remote-contract")).toEqual(["remote-contract"]);
  });
});

describe("bestOutcome", () => {
  it("prefers a pass on any route over a reject on another", () => {
    const chosen = bestOutcome([
      { route: "hsm", verdict: { status: "reject" as const, reasons: [] } },
      { route: "remote-contract", verdict: { status: "pass" as const, reasons: [] } },
    ]);
    expect(chosen.route).toBe("remote-contract");
  });

  it("prefers a flag over a reject", () => {
    const chosen = bestOutcome([
      { route: "hsm", verdict: { status: "reject" as const, reasons: [] } },
      { route: "remote-contract", verdict: { status: "flag" as const, reasons: [] } },
    ]);
    expect(chosen.verdict.status).toBe("flag");
  });
});

describe("screenJobTool.execute — HSM route", () => {
  it("rejects a company that is absent from the IND register", async () => {
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: `€80.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.success).toBe(true);
    expect(res.data).toContain("REJECT");
    expect(res.data).toContain("recognised-sponsor register");
  });

  it("rejects a recognised sponsor advertising below the permit floor", async () => {
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `Salary €40.000 per jaar excl. vakantiegeld. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("REJECT");
    expect(res.data).toContain("52284");
  });

  it("passes a recognised sponsor clearing the floor", async () => {
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      description: `€70.000 - €90.000 per jaar excl. vakantiegeld. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("PASS");
    expect(mockRecord).toHaveBeenCalledOnce();
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({
      sponsor_verdict: "sponsor",
      salary_status: "pass",
      route: "hsm",
      stage: "screened",
    });
  });

  it("flags rather than rejects when no salary is stated", async () => {
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: ENGLISH_ONSITE,
    });

    expect(res.data).toContain("NEEDS A HUMAN CHECK");
  });

  it("records the canonical register name on an exact sponsor match", async () => {
    await screenJobTool.execute({
      company: "adyen nv",
      title: "AI Engineer",
      description: `€80.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(mockRecord.mock.calls[0]![0]).toMatchObject({ registered_name: "Adyen N.V." });
  });
});

describe("screenJobTool.execute — the defects this rewrite closes", () => {
  it("rejects a Dutch-language requirement written IN DUTCH", async () => {
    // The English-only predecessor passed this — the single worst false PASS.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `€80.000 per jaar. Vloeiend Nederlands is vereist voor deze functie. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("REJECT");
    expect(res.data).toMatch(/Nederlands|Dutch/);
  });

  it("passes a monthly salary that clears the floor instead of flagging it", async () => {
    // "€5.000 per maand" is €60k/yr. The predecessor flagged it as implausible.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `Wij bieden €5.000 per maand excl. vakantiegeld. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("PASS");
  });

  it("does not read the Dutch thousands separator as a decimal point", async () => {
    // "€4.500" is 4500, not 4.5. Reading it as 4.5 rejects the entire market.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `€4.500 - €6.000 per maand excl. vakantiegeld. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("PASS");
  });

  it("flags a figure whose holiday-allowance basis decides the verdict", async () => {
    // €54k stated: €54k excl. clears, €50k incl. does not. Genuinely a human call.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `€54.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("NEEDS A HUMAN CHECK");
    expect(res.data).toContain("holiday allowance");
  });

  it("does NOT flag when the holiday-allowance basis cannot change the verdict", async () => {
    // €90k clears the floor under either reading — not worth a founder's minute.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `€90.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("PASS");
  });

  it("warns about a cosmetic re-post without blocking it", async () => {
    mockSoft.mockResolvedValue([{ title: "AI Engineer (Senior)", stage: "applied" }]);

    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      description: `€90.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).toContain("POSSIBLE RE-POST");
    expect(res.data).toContain("AI Engineer (Senior)");
    expect(mockRecord).toHaveBeenCalledOnce();
  });
});

describe("screenJobTool.execute — remote-contract route", () => {
  it("does not apply the sponsor gate to a remote contract at a non-sponsor", async () => {
    // The campaign's highest-EV channel. The single-route design rejected these.
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: "Fully remote freelance contract. €60 per hour. We work in English.",
    });

    expect(res.data).toContain("PASS");
    expect(res.data).toContain("remote-contract route");
    expect(mockRecord.mock.calls[0]![0]).toMatchObject({ route: "remote-contract" });
  });

  it("still rejects a remote contract below the rate floor", async () => {
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: "Fully remote freelance contract. €12 per hour. We work in English.",
    });

    expect(res.data).toContain("REJECT");
  });

  it("rescues an unclear posting that fails HSM but clears the contract rate", async () => {
    // Not on the register, no on-site/remote marker either way → both routes run.
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: "€70 per hour. We work in English.",
    });

    expect(res.data).toContain("PASS");
    expect(res.data).toContain("remote-contract route");
  });
});

describe("screenJobTool.execute — duplicate and failure handling", () => {
  it("refuses to re-apply to a role already applied to, and writes nothing", async () => {
    mockFind.mockResolvedValue({
      id: "ja1",
      stage: "applied",
      applied_at: new Date(Date.now() - 86_400_000),
    });

    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "Senior AI Engineer",
      description: `€90.000 per jaar. ${ENGLISH_ONSITE}`,
    });

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
      description: `€90.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).not.toContain("ALREADY IN PIPELINE");
    expect(mockRecord).toHaveBeenCalledOnce();
  });

  it("fails loudly when the tracker is unreachable rather than screening blind", async () => {
    mockFind.mockRejectedValue(new Error("connection refused"));

    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: ENGLISH_ONSITE,
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain("tracker unreachable");
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("rejects empty input instead of writing a junk row", async () => {
    const res = await screenJobTool.execute({ company: "  ", title: "AI Engineer", description: "x" });

    expect(res.success).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
