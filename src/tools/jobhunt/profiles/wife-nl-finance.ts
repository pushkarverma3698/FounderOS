/**
 * FounderOS — Job Search Profile for Wife (Finance / Accounting / NL)
 * ==================================================================
 * Target market: Netherlands
 * Profession: Finance / Accounting / Financial Analysis
 * Visa status: Job search visa (Orientation Year / Zoekjaar), switching to HSM sponsorship
 */

import type { JobSearchProfile } from "../profile-config.js";

export const WIFE_FINANCE_PROFILE: JobSearchProfile = {
  id: "wife-nl-finance",
  tenantId: "turicks",
  candidateName: "Wife",
  dob: new Date("1998-01-01T00:00:00Z"),
  
  experienceYears: 2.0,
  maxYearsDemanded: 4,
  maxYearsStretch: 5,

  visaRequiresSponsor: true, // HSM sponsorship required for work permit transition
  permitBases: ["hsm", "partner-permit"],
  
  under30MonthlyEurFloor: 4357, // IND 2026 under-30 HSM threshold
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
