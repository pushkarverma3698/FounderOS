/**
 * Manual QA Integration Test Suite — Multi-Profile Verification
 * =============================================================
 * Verifies all 5 core multi-profile scenarios:
 *   Scenario 1: Profile registry & isolation
 *   Scenario 2: Country classification per profile
 *   Scenario 3: Track classification (Tech vs Finance)
 *   Scenario 4: Experience gate thresholds per profile
 *   Scenario 5: Skill dictionary & overlap scoring isolation
 */

import { describe, it, expect, vi } from "vitest";
import { PUSHKAR_PROFILE, getProfile } from "../../../src/tools/jobhunt/profile-config.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import { countryFromLocation } from "../../../src/tools/jobhunt/country.js";
import { experienceGate, extractExperienceDemand } from "../../../src/tools/jobhunt/experience.js";
import { classifyTrack } from "../../../src/tools/jobhunt/tracks.js";
import { extractSkillTerms } from "../../../src/tools/jobhunt/skills.js";
import { overlapScore } from "../../../src/tools/jobhunt/overlap.js";

vi.mock("../../../src/db/cv-signal-queries.js", () => ({
  recordSignals: vi.fn(async () => 0),
  listSignals: vi.fn(async () => []),
}));

/** What `recordScreenedApplication` was actually asked to store. */
const recorded: Array<Record<string, unknown>> = [];

vi.mock("../../../src/db/job-queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    findApplicationByDedupeKey: vi.fn(async () => null),
    findApplicationsBySoftKey: vi.fn(async () => []),
    recordScreenedApplication: vi.fn(async (row: Record<string, unknown>) => {
      recorded.push(row);
      return { id: "ja1", ...row };
    }),
  };
});

const { screenPosting } = await import("../../../src/tools/jobhunt/screen.js");

describe("Manual QA Audit — Multi-Profile Verification", () => {
  it("Scenario 1: Profile registry is loaded and distinct", () => {
    const pushkar = getProfile("pushkar-nl-tech");
    const wife = getProfile("wife-nl-finance");

    expect(pushkar.id).toBe("pushkar-nl-tech");
    expect(wife.id).toBe("wife-nl-finance");
    expect(wife.skillsDictionaryName).toBe("finance");
    expect(pushkar.skillsDictionaryName).toBe("tech");
    expect(wife.experienceYears).toBe(2.4);
    expect(pushkar.experienceYears).toBe(3.5);
  });

  it("Scenario 2: Country classification respects profile config", () => {
    const pushkar = getProfile("pushkar-nl-tech");
    const wife = getProfile("wife-nl-finance");

    expect(countryFromLocation("Amsterdam, Netherlands", pushkar)).toBe("NL");
    expect(countryFromLocation("Bangalore, India", pushkar)).toBe("IN");
    expect(countryFromLocation("Berlin, Germany", pushkar)).toBe("other");
    expect(countryFromLocation("Amsterdam, Netherlands", wife)).toBe("NL");
  });

  it("Scenario 3: Track classification isolates Tech vs Finance roles", () => {
    const pushkar = getProfile("pushkar-nl-tech");
    const wife = getProfile("wife-nl-finance");

    const techTitle = "Senior AI Engineer";
    const financeTitle = "Financial Analyst & Controller";

    expect(classifyTrack(techTitle, pushkar)).toBe("ai");
    expect(classifyTrack(financeTitle, pushkar)).toBeNull(); // Unclassified for Pushkar

    expect(classifyTrack(financeTitle, wife)).toBe("fpa");
    expect(classifyTrack(techTitle, wife)).toBeNull(); // Unclassified for Wife
  });

  it("Scenario 4: Experience gate thresholds differ by profile", () => {
    const pushkar = getProfile("pushkar-nl-tech");
    const wife = getProfile("wife-nl-finance");

    const posting5Years = "At least 5 years experience in financial reporting required.";

    const pushkarVerdict = experienceGate(posting5Years, "Software Engineer", pushkar);
    const wifeVerdict = experienceGate(posting5Years, "Financial Analyst", wife);

    // Pushkar (3.5y exp, maxDemanded=4, maxStretch=6): 5y is a STRETCH -> flag
    expect(pushkarVerdict.status).toBe("flag");
    expect(pushkarVerdict.evidence).toContain("3.5");

    // Wife (2.4y exp, maxDemanded=4, maxStretch=5): 5y is a STRETCH -> flag
    expect(wifeVerdict.status).toBe("flag");
    expect(wifeVerdict.evidence).toContain("2");
  });

  it("Scenario 5: Skill dictionary & overlap scoring isolation", () => {
    const pushkar = getProfile("pushkar-nl-tech");
    const wife = getProfile("wife-nl-finance");

    const financePostingText = `
      Required: IFRS, Dutch GAAP, Financial Modeling, SAP, Excel, and Tax Compliance.
      Internal auditing background required.
    `;

    const wifeCvText = `
      FINANCIAL ANALYST
      Skills: IFRS, Dutch GAAP, Financial Modeling, SAP, Power BI, Excel, Auditing.
    `;

    const techOverlap = overlapScore(financePostingText, wifeCvText, pushkar.skillsDictionaryName);
    const financeOverlap = overlapScore(financePostingText, wifeCvText, wife.skillsDictionaryName);

    expect(techOverlap.ratio).toBe(0);
    expect(financeOverlap.ratio).toBeGreaterThan(0.5);
    expect(financeOverlap.matched).toContain("IFRS");
    expect(financeOverlap.matched).toContain("Financial Modeling");
  });

  it("Scenario 6: End-to-end screenPosting with explicit profile", async () => {
    const wife = getProfile("wife-nl-finance");

    const fullDescription = `
      ING Bank is seeking a talented Financial Analyst to join our Global Finance & Accounting team in Amsterdam.
      As a Financial Analyst, you will be responsible for preparing monthly financial statements, budget forecasting,
      variance analysis, and ensuring full compliance with IFRS and Dutch GAAP accounting standards.

      Key Responsibilities:
      - Prepare and review month-end and year-end financial statement consolidations using SAP ERP.
      - Conduct quarterly FP&A variance analysis and present financial performance metrics to senior leadership.
      - Work closely with external statutory auditors and ensure internal financial controls are maintained.

      Requirements:
      - At least 2 years experience in financial analysis, general ledger accounting, or financial control.
      - Strong working knowledge of IFRS, Dutch GAAP, SAP, Excel (financial modeling), and Power BI.
      - Excellent communication skills in English; Dutch is a plus but not required.

      Compensation & Benefits:
      - Competitive gross monthly salary of €4,600/month gross plus 8% holiday allowance.
      - Full visa sponsorship and relocation support for qualified international candidates.
    `;

    const result = await screenPosting({
      company: "ING Bank",
      title: "Financial Analyst",
      description: fullDescription,
      location: "Amsterdam, Netherlands",
      profile: wife,
    });

    expect(result.kind).toBe("screened");
    if (result.kind === "screened") {
      expect(result.track).toBe("fpa");
      expect(result.verdict.status).toBe("pass");
      expect(result.company).toBe("ING Bank");
      // ZOEKJAAR, not partner-permit. She holds an orientation-year permit and
      // has never held a partner permit; the earlier expectation asserted a
      // pass carried by a right to work she does not have. On the zoekjaar
      // basis the sponsor gate and the salary floor both correctly stand down.
      expect(result.route).toBe("zoekjaar");
    }

    // The row is STORED under her profile. This was claimed as verified before
    // it was true: the mock swallowed the argument and nothing asserted it, so
    // `profile_id` could have been absent and every test still passed.
    const row = recorded.at(-1);
    expect(row?.["profile_id"]).toBe("wife-nl-finance");
    expect(row?.["tenant_id"]).toBe("turicks");
  });
});
