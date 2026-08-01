/**
 * Unit tests — screening an Indian posting end to end (DB mocked).
 *
 * The whole point of adding a second market is that it is judged by its OWN
 * rules. An Indian role has no recognised sponsor to look up, no IND salary
 * criterion to clear, and no Dutch-language bar — he lives in India and already
 * has the right to work there. Applying any of those to it would be the mirror
 * image of the defect that started this: nine Indeed-IN rows stored under a
 * Dutch permit basis because "hybrid" was read as proof of a Dutch office.
 *
 * So these tests assert the ABSENCE of gates as hard as their presence. A
 * cleared check about a permit nobody needs is not harmless — it is a line in
 * the founder's brief that says a legal question was answered, when no legal
 * question was ever asked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFind = vi.fn(async (_key: string) => null as Record<string, unknown> | null);
const mockSoft = vi.fn(async (_soft: string, _exclude: string) => [] as Record<string, unknown>[]);
const mockRecord = vi.fn(async (row: Record<string, unknown>) => ({ id: "ja1", ...row }));

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

const { screenPosting } = await import("../../../src/tools/jobhunt/screen.js");

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue(null);
  mockSoft.mockResolvedValue([]);
});

/** A realistic Indian posting body — long enough to clear the thin-body gate. */
const INDIAN_BODY = [
  "This is a hybrid role based out of our Bengaluru office, three days a week.",
  "About the role: you will join the platform team building data services used",
  "across the product. You will own services end to end, from design through",
  "deployment and on-call, and work closely with product on what gets built next.",
  "What you will do: design and ship backend services in TypeScript and Node.js;",
  "model data in PostgreSQL; instrument what you build so it can be operated;",
  "review your colleagues' code and have yours reviewed. We are looking for 3+",
  "years of experience shipping production software.",
  "What we offer: health cover, a learning budget, and an annual offsite.",
].join(" ");

async function screenIndian(over: Record<string, unknown> = {}) {
  const outcome = await screenPosting({
    company: "Zzyzx Widgetworks India",
    title: "Backend Engineer",
    description: INDIAN_BODY,
    country: "IN",
    location: "Bengaluru, Karnataka, India",
    source: "indeed-ingest",
    ...over,
  });
  if (outcome.kind !== "screened") throw new Error(`expected a screened outcome, got ${outcome.kind}`);
  return outcome;
}

function gateNames(outcome: Awaited<ReturnType<typeof screenIndian>>): string[] {
  return outcome.verdict.gates.map((g) => g.gate);
}

describe("an Indian posting is screened as an Indian local hire", () => {
  it("records the India basis, not a Dutch permit", async () => {
    const outcome = await screenIndian();
    expect(outcome.route).toBe("india-local");
  });

  it("REGRESSION: 'hybrid' in an Indian ad does not summon a Dutch permit", async () => {
    // The exact sentence from the live defect. The body says "hybrid" and
    // nothing else about geography; the COUNTRY is what settles it.
    expect(INDIAN_BODY).toContain("hybrid");
    const outcome = await screenIndian();
    expect(outcome.route).not.toBe("hsm");
    expect(outcome.route).not.toBe("partner-permit");
  });

  it("applies no sponsor gate — there is no register to be on", async () => {
    expect(gateNames(await screenIndian())).not.toContain("Sponsor");
  });

  it("applies no Dutch-language gate", async () => {
    // It would have PASSED, which is the problem: a cleared check about a
    // language nobody asked for reads as a legal question that was answered.
    expect(gateNames(await screenIndian())).not.toContain("Language");
  });

  it("applies no IND salary criterion", async () => {
    const names = gateNames(await screenIndian());
    expect(names).not.toContain("Salary");
    expect(names).toContain("Pay");
  });

  it("raises no Location question — the feed said where it is", async () => {
    expect(gateNames(await screenIndian())).not.toContain("Location");
  });

  it("stores the country and the location string it was given", async () => {
    await screenIndian();
    const stored = mockRecord.mock.calls[0]![0]!;
    expect(stored["country"]).toBe("IN");
    expect(stored["location"]).toBe("Bengaluru, Karnataka, India");
  });

  it("never quotes euros at an Indian role", async () => {
    const outcome = await screenIndian();
    expect(outcome.verdict.reasons.join(" ")).not.toContain("€");
  });
});

describe("the rupee line changes placement, never lawfulness", () => {
  it("passes a role at or above ₹15 LPA", async () => {
    const outcome = await screenIndian({
      description: `${INDIAN_BODY} Compensation: 24 LPA.`,
    });
    expect(outcome.verdict.status).toBe("pass");
  });

  it("FLAGS a role below the line, and does not reject it", async () => {
    const outcome = await screenIndian({
      description: `${INDIAN_BODY} Compensation: 8 LPA.`,
    });
    expect(outcome.verdict.status).toBe("flag");
    expect(outcome.verdict.status).not.toBe("reject");

    const pay = outcome.verdict.gates.find((g) => g.gate === "Pay");
    expect(pay!.evidence).toContain("₹8 LPA");
  });

  it("reads lakh grouping, not European grouping", async () => {
    // ₹12,00,000 is twelve lakh — 1.2 million rupees. A euro parser would agree
    // on the digits and then compare them to a €52,284 floor.
    const outcome = await screenIndian({
      description: `${INDIAN_BODY} Compensation: ₹12,00,000 per annum.`,
    });
    const pay = outcome.verdict.gates.find((g) => g.gate === "Pay");
    expect(pay!.evidence).toContain("₹12 LPA");
  });
});

describe("a Dutch posting is untouched by any of this", () => {
  it("keeps the sponsor, salary and language gates", async () => {
    const outcome = await screenPosting({
      company: "Adyen N.V.",
      title: "Backend Engineer",
      description:
        "On-site in Amsterdam. Visa sponsorship available. We work in English. " +
        INDIAN_BODY.slice(INDIAN_BODY.indexOf("About the role")),
      country: "NL",
      location: "Amsterdam, North Holland, Netherlands",
      source: "ats-ingest",
    });
    if (outcome.kind !== "screened") throw new Error("expected a screened outcome");

    const names = outcome.verdict.gates.map((g) => g.gate);
    expect(names).toContain("Language");
    expect(names).not.toContain("Pay");
    expect(outcome.route).not.toBe("india-local");
  });
});
