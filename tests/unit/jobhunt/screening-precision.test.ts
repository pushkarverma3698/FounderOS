/**
 * Unit tests — the precision mechanisms.
 *
 * Three separate defences against the pipeline's silent failure mode, which is
 * a confident REJECT of a role that was actually fine:
 *   · register staleness must downgrade a negative, never a positive
 *   · an ambiguity only reaches the founder when it changes the verdict
 *   · a cosmetic re-post warns without blocking
 */

import { describe, it, expect } from "vitest";
import {
  registerStaleness,
  parseScrapedAt,
  REGISTER_MAX_AGE_DAYS,
} from "../../../src/tools/jobhunt/sponsor-registry.js";
import {
  screenSalaryFacts,
  candidateAnnualBases,
  softDedupeKey,
  dedupeKey,
} from "../../../src/tools/jobhunt/filters.js";
import type { SalaryFacts } from "../../../src/tools/jobhunt/extract.js";

const NOW = new Date("2026-07-29T00:00:00Z");
const facts = (over: Partial<SalaryFacts>): SalaryFacts => ({
  unit: "annual",
  unitInferred: false,
  holidayBasis: "unstated",
  ...over,
});

describe("parseScrapedAt", () => {
  it("reads the scrape stamp the scraper writes", () => {
    expect(parseScrapedAt("# scraped: 2026-07-29\nname,kvk\n")?.toISOString().slice(0, 10)).toBe(
      "2026-07-29",
    );
  });

  it("returns null when the file carries no stamp", () => {
    expect(parseScrapedAt("name,kvk\nAdyen N.V.,1\n")).toBeNull();
  });
});

describe("registerStaleness", () => {
  it("accepts a register inside one IND publication cycle", () => {
    const s = registerStaleness(new Date("2026-07-20T00:00:00Z"), NOW);
    expect(s.stale).toBe(false);
    expect(s.ageDays).toBe(9);
  });

  it("marks a register past the cycle as stale, with the re-scrape command", () => {
    const old = new Date(NOW.getTime() - (REGISTER_MAX_AGE_DAYS + 5) * 86_400_000);

    const s = registerStaleness(old, NOW);

    expect(s.stale).toBe(true);
    expect(s.note).toContain("scripts/ind-sponsors.ts");
  });

  it("treats an unstamped register as stale — unknown age is not a safe age", () => {
    expect(registerStaleness(null, NOW).stale).toBe(true);
  });
});

describe("screenSalaryFacts — the verdict-relevance rule", () => {
  it("passes without a flag when the ambiguity cannot change the answer", () => {
    // €90k clears €52,284 whether or not the 8% is included. Not worth a minute.
    const r = screenSalaryFacts(facts({ max: 90_000 }), { now: NOW });
    expect(r.status).toBe("pass");
  });

  it("flags when the holiday basis straddles the floor", () => {
    // €54k excl. clears; €50k incl. does not. Genuinely a human call.
    const r = screenSalaryFacts(facts({ max: 54_000 }), { now: NOW });
    expect(r.status).toBe("flag");
    expect(r.evidence).toContain("holiday allowance");
  });

  it("rejects without a flag when every reading is below the floor", () => {
    const r = screenSalaryFacts(facts({ max: 30_000 }), { now: NOW });
    expect(r.status).toBe("reject");
  });

  it("converts a monthly figure rather than calling it implausible", () => {
    const r = screenSalaryFacts(
      facts({ max: 5_000, unit: "monthly", holidayBasis: "excluded" }),
      { now: NOW },
    );
    expect(r.status).toBe("pass");
  });

  it("converts an hourly contract rate to an annual base", () => {
    const r = screenSalaryFacts(
      facts({ max: 60, unit: "hourly", holidayBasis: "excluded" }),
      { route: "remote-contract", now: NOW },
    );
    expect(r.status).toBe("pass");
  });

  it("flags a part-time posting only when pro-rating changes the verdict", () => {
    // €60k FTE at 0.8 → €48k, below the floor. Straddles, so a human decides.
    const straddles = screenSalaryFacts(
      facts({ max: 60_000, holidayBasis: "excluded", fteFactor: 0.8 }),
      { now: NOW },
    );
    expect(straddles.status).toBe("flag");

    // €90k FTE at 0.8 → €72k, still clears. No human needed.
    const clears = screenSalaryFacts(
      facts({ max: 90_000, holidayBasis: "excluded", fteFactor: 0.8 }),
      { now: NOW },
    );
    expect(clears.status).toBe("pass");
  });

  it("flags rather than asserting when no criterion is verified for the date", () => {
    // IND revises every 1 January; the table covers 2026 only.
    const r = screenSalaryFacts(facts({ max: 90_000 }), { now: new Date("2027-03-01T00:00:00Z") });
    expect(r.status).toBe("flag");
    expect(r.evidence).toContain("ind.nl");
  });

  it("flags when the posting states no salary at all", () => {
    expect(screenSalaryFacts(facts({ unit: "none" }), { now: NOW }).status).toBe("flag");
  });
});

describe("candidateAnnualBases", () => {
  it("enumerates both holiday readings when the basis is unstated", () => {
    expect(candidateAnnualBases(facts({ max: 54_000 }))).toHaveLength(2);
  });

  it("enumerates one reading when the basis is stated", () => {
    expect(candidateAnnualBases(facts({ max: 54_000, holidayBasis: "excluded" }))).toEqual([54_000]);
  });

  it("doubles the readings again when part-time hours are advertised", () => {
    expect(candidateAnnualBases(facts({ max: 54_000, fteFactor: 0.8 }))).toHaveLength(4);
  });

  it("yields nothing when there is no usable figure", () => {
    expect(candidateAnnualBases(facts({ unit: "none" }))).toEqual([]);
  });
});

describe("softDedupeKey", () => {
  it("collapses the cosmetic spellings of one role", () => {
    const a = softDedupeKey("Adyen N.V.", "Senior AI Engineer");
    expect(softDedupeKey("Adyen N.V.", "AI Engineer (Senior)")).toBe(a);
    expect(softDedupeKey("Adyen N.V.", "Senior AI Engineer (m/f/d)")).toBe(a);
    expect(softDedupeKey("Adyen N.V.", "Senior AI Engineer - Full-time")).toBe(a);
  });

  it("keeps genuinely different roles apart", () => {
    expect(softDedupeKey("Adyen N.V.", "Senior AI Engineer")).not.toBe(
      softDedupeKey("Adyen N.V.", "Senior Data Engineer"),
    );
  });

  it("stays weaker than the blocking key, which still separates those spellings", () => {
    // The soft key warns; only the exact key prevents an application.
    expect(dedupeKey("Adyen N.V.", "Senior AI Engineer")).not.toBe(
      dedupeKey("Adyen N.V.", "AI Engineer (Senior)"),
    );
  });
});

describe("sponsorGate — staleness downgrades only the negative", () => {
  it("downgrades a not-sponsor verdict to a human check on a stale register", async () => {
    // A company recognised last week is simply absent from last quarter's file.
    // Rejecting it would be a confident, invisible loss of a real opportunity.
    const { sponsorGate } = await import("../../../src/tools/jobhunt/screen.js");
    const stale = registerStaleness(null, NOW);

    const gate = sponsorGate(
      { verdict: "not-sponsor", candidates: [], evidence: "absent from the register" },
      stale,
    );

    expect(gate.status).toBe("flag");
    expect(gate.evidence).toContain("cannot be trusted");
  });

  it("leaves a positive match alone however old the register is", async () => {
    // A stale file cannot invent a sponsor, so a match stays valid.
    const { sponsorGate } = await import("../../../src/tools/jobhunt/screen.js");

    const gate = sponsorGate(
      { verdict: "sponsor", registered_name: "Adyen N.V.", candidates: [], evidence: "exact match" },
      registerStaleness(null, NOW),
    );

    expect(gate.status).toBe("pass");
  });

  it("rejects confidently when the register is fresh", async () => {
    const { sponsorGate } = await import("../../../src/tools/jobhunt/screen.js");

    const gate = sponsorGate(
      { verdict: "not-sponsor", candidates: [], evidence: "absent from the register" },
      registerStaleness(new Date("2026-07-20T00:00:00Z"), NOW),
    );

    expect(gate.status).toBe("reject");
  });
});
