/**
 * FounderOS — Job Search Profile for Wife (Finance / Accounting / NL)
 * ==================================================================
 * Target market: Netherlands
 * Profession: Finance / Accounting / Financial Analysis
 *
 * PERMIT — confirmed by the founder, 2026-09-04: "she's on zoekjaar".
 *
 * The orientation year gives free access to the Dutch labour market: no
 * recognised sponsor, no work permit, no IND salary criterion. That is why
 * `zoekjaar` leads `permitBases` — it is what makes a role reachable TODAY, and
 * screening her under `hsm` alone (as this file did until 2026-09-04) applied the
 * recognised-sponsor register to every Dutch employer and rejected most of a
 * market she can lawfully work in.
 *
 * `hsm` stays second because the orientation year is time-boxed and
 * non-renewable. Screening under both means the verdict says which basis carried
 * the role, so a job that ends with the permit is visibly different from one an
 * employer could sponsor afterwards.
 *
 * NOT CONFIRMED, and therefore not asserted anywhere: she has never held a
 * partner permit, so that basis is deliberately absent.
 */

import type { JobSearchProfile } from "../profile-config.js";

export const WIFE_FINANCE_PROFILE: JobSearchProfile = {
  id: "wife-nl-finance",
  tenantId: "turicks",
  // PLACEHOLDER — the founder has not supplied her legal name. It reaches the
  // agent prompt and the application packet, so it must be replaced before any
  // application is sent. See docs/sessions/2026-09-04-multi-profile-jobhunt.md.
  candidateName: "Wife",
  // Confirmed by the founder, 2026-09-04: 7 April 2001. This selects the IND age
  // band in criteria.ts (under-30 until 2031-04-07), which is a legal threshold —
  // it was a 1998-01-01 placeholder until today.
  dob: new Date("2001-04-07T00:00:00Z"),

  experienceYears: 2.0,
  maxYearsDemanded: 4,
  maxYearsStretch: 5,

  permitBases: ["zoekjaar", "hsm"],

  // Display copies of the criteria.ts figures, for prompt text only. The binding
  // floor is looked up by date and dob in criteria.ts, and it does not apply at
  // all while she is on the zoekjaar basis.
  under30MonthlyEurFloor: 4357,
  over30MonthlyEurFloor: 5942,

  targetCountries: [
    {
      code: "NL",
      names: ["netherlands", "the netherlands", "nederland", "holland"],
      cities: [
        "amsterdam", "rotterdam", "utrecht", "eindhoven", "den haag", "the hague",
        "groningen", "tilburg", "almere", "breda", "nijmegen", "haarlem", "arnhem",
        "amersfoort", "delft", "leiden", "zwolle", "maastricht", "hilversum", "schiphol",
        "hoofddorp", "amstelveen", "diemen", "zaandam", "purmerend", "hoorn", "alkmaar",
        "lelystad", "apeldoorn", "deventer", "enschede", "hengelo", "zutphen", "doetinchem",
        "den bosch", "'s-hertogenbosch", "hertogenbosch", "helmond", "veldhoven",
      ],
      atsLocations: ["Netherlands"],
    },
  ],

  tracks: {
    "financial-analyst": {
      id: "financial-analyst",
      name: "Financial Analyst",
      titles: [
        "Financial Analyst:*",
        "FP&A Analyst:*",
        "Finance Analyst:*",
        "Business Analyst Finance:*",
        "Financial Controller:*",
      ],
      classifyTerms: [
        "financial analyst",
        "fp&a analyst",
        "finance analyst",
        "financial controller",
        "junior financial analyst",
      ],
      cvPath: "mac-client/cv/cv-wife-financial-analyst.md",
    },
    accountant: {
      id: "accountant",
      name: "Accountant / General Ledger",
      titles: [
        "Accountant:*",
        "Financial Accountant:*",
        "GL Accountant:*",
        "General Ledger Accountant:*",
        "Staff Accountant:*",
        "Junior Accountant:*",
      ],
      classifyTerms: [
        "accountant",
        "financial accountant",
        "gl accountant",
        "staff accountant",
        "junior accountant",
      ],
      cvPath: "mac-client/cv/cv-wife-accountant.md",
    },
    auditor: {
      id: "auditor",
      name: "Auditor / Internal Controls",
      titles: [
        "Internal Auditor:*",
        "Audit Associate:*",
        "Risk & Compliance Analyst:*",
      ],
      classifyTerms: [
        "internal auditor",
        "audit associate",
        "auditor",
        "compliance analyst",
      ],
      cvPath: "mac-client/cv/cv-wife-auditor.md",
    },
  },

  trackPriority: ["financial-analyst", "accountant", "auditor"],
  skillsDictionaryName: "finance",
  baseCvPath: "mac-client/cv/cv-wife-base.md",
};
