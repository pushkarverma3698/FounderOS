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
const { extractPostingFacts } = await import("../../../src/tools/jobhunt/extract.js");
const { screenSalaryFacts } = await import("../../../src/tools/jobhunt/filters.js");

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
  it("screens an unclear posting under every live permit basis rather than guessing", () => {
    // Guessing wrong in any direction loses something, so all live bases are run.
    expect(routesToScreen("unclear")).toEqual(["hsm", "partner-permit", "remote-contract"]);
  });

  it("screens a Netherlands-based posting under every basis that could carry it", () => {
    // One NL role can be lawful under HSM *or* a partner permit — those are
    // different legal bases with different gates, not one route. Screening only
    // HSM is what rejected roles that a partner permit makes perfectly reachable.
    expect(routesToScreen("hsm")).toEqual(["hsm", "partner-permit"]);
  });

  it("screens a remote contract only as a remote contract", () => {
    // No Dutch permit is involved in contracting from India, so no permit basis
    // other than the contract itself has anything to say about it.
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
  it("flags rather than rejects a company absent from the IND register", async () => {
    // Founder decision, 2026-07-31: recognition costs an employer ~€4,500 and
    // ~4 weeks, and they do take it on for someone they want — so absence today
    // is not "cannot hire you". Rejecting made that permanently invisible; there
    // is no signal emitted when a rejection was wrong.
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: `€80.000 per jaar. ${ENGLISH_ONSITE}`,
    });

    expect(res.success).toBe(true);
    expect(res.data).not.toContain("REJECT");
    expect(res.data).toContain("recognised-sponsor register");
  });

  it("no longer rejects a below-floor salary outright, because another basis carries it", async () => {
    // €40k is genuinely void on the HSM basis — the permit cannot be granted. But
    // the same role is lawful on a partner permit, which has no salary criterion
    // at all. So the posting survives as a human check rather than a hard no.
    const res = await screenJobTool.execute({
      company: "Adyen N.V.",
      title: "AI Engineer",
      description: `Salary €40.000 per jaar excl. vakantiegeld. ${ENGLISH_ONSITE}`,
    });

    expect(res.data).not.toContain("REJECT");
    expect(res.data).toContain("NEEDS A HUMAN CHECK");
  });

  it("still rejects €40k on the HSM basis itself — the legal floor is untouched", () => {
    // The guarantee that must survive the multi-basis change: widening the routes
    // must not quietly soften the one gate that encodes actual law. An employer
    // cannot lawfully make this hire under the highly skilled migrant scheme.
    const facts = extractPostingFacts(`Salary €40.000 per jaar excl. vakantiegeld. ${ENGLISH_ONSITE}`);
    const result = screenSalaryFacts(facts.salary, { route: "hsm" });

    expect(result.status).toBe("reject");
    expect(result.evidence).toContain("52284");
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

  it("flags a figure whose holiday-allowance basis decides the HSM verdict", () => {
    // €54k stated: €54k excl. clears the floor, €50k incl. does not. Genuinely a
    // human call — but ONLY on the basis that has a floor. Asserted directly on
    // the HSM basis, because the tool now reports the best basis of several and a
    // partner permit is indifferent to which reading is right.
    const facts = extractPostingFacts(`€54.000 per jaar. ${ENGLISH_ONSITE}`);
    const result = screenSalaryFacts(facts.salary, { route: "hsm" });

    expect(result.status).toBe("flag");
    expect(result.evidence).toContain("holiday allowance");
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

  it("flags — never rejects — a low remote rate, since no legal floor applies", async () => {
    // €12/hour is poor, and that is worth surfacing. But it is not unlawful:
    // a remote contract involves no Dutch permit, so there is no criterion to
    // breach. Rejecting would assert a legal bar that does not exist.
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: "Fully remote freelance contract. €12 per hour. We work in English.",
    });

    expect(res.data).not.toContain("REJECT");
    expect(res.data).toContain("NEEDS A HUMAN CHECK");
    expect(res.data).toContain("NOT a legal bar");
  });

  it("rescues an unclear posting that fails HSM but is fine on a no-sponsor basis", async () => {
    // Not on the register, no on-site/remote marker either way → every live basis
    // runs and the best wins. Which no-sponsor basis carries it is not the point;
    // that it survives at all is.
    const res = await screenJobTool.execute({
      company: "Zzyzx Widgetworks",
      title: "AI Engineer",
      description: "€70 per hour. We work in English.",
    });

    expect(res.data).toContain("PASS");
    expect(mockRecord.mock.calls[0]![0]!.route).not.toBe("hsm");
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
