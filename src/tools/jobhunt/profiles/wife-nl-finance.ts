/**
 * FounderOS — Job Search Profile for Tashi Goyal (Finance / NL)
 * ===============================================================
 * Target market: Netherlands
 * Profession: FP&A / Business Controlling / Regulatory Compliance (KYC-AML) / Audit
 *
 * IDENTITY — supplied by the founder, 2026-09-04, from her real CV
 * (Tashi_CV_FP&A.pdf) and cover letter. Replaces the "Wife" placeholder that
 * reached the agent prompt and the application packet until today.
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
  candidateName: "Tashi Goyal",
  // Confirmed by the founder, 2026-09-04: 7 April 2001. This selects the IND age
  // band in criteria.ts (under-30 until 2031-04-07), which is a legal threshold.
  dob: new Date("2001-04-07T00:00:00Z"),

  // COMPUTED from her CV's own dates (2026-09-04), not asserted — recompute if
  // this drifts:
  //   Analyst, TIDE            Oct 2022 – Dec 2023   15 months
  //   Senior Analyst, TIDE     Jan 2024 – Aug 2024     8 months
  //   Finance Intern, HBS      Mar 2026 – present      6 months (as of Sept 2026)
  //   -------------------------------------------------------
  //   Total                                           29 months  ≈ 2.4 years
  // The HBS internship is counted at full weight: her CV describes owning a
  // controlled deliverable (the FTE Tracker) and reporting directly to two
  // directors, not observation work. If that reads as generous, the more
  // conservative floor is TIDE alone — 23 months ≈ 1.9 years.
  experienceYears: 2.4,
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

  // Keyword sets researched against live Dutch/EU postings (2026-09-04) — not
  // guessed. `titles` feeds BOTH the metered-lane query (the literal phrase
  // sent to Indeed) and the free-lane classifier's substring pass; `classifyTerms`
  // is the free-lane whole-word pass. See tracks.ts for why both exist and why
  // spelling variants ("Engineer" vs "Developer", here: "Analyst" vs
  // "Specialist" vs "Officer") must each be enumerated rather than assumed
  // interchangeable — Dutch postings do not use them as synonyms.
  //
  // Every track's `cvPath` points at the SAME file (`baseCvPath` below — she has
  // one real CV, not four). This is NOT optional the way it looks: omitting it
  // does not fall back to `baseCvPath`. `loadTrackCvs` (brief-cv.ts) only reads
  // `baseCvPath` for a row that matched NO track; a row that matched fpa,
  // compliance-kyc, auditor or accountant resolves through `cvPathsForTrack`,
  // which falls back to the GLOBAL `PERSONAL_CV_DIR`/`PERSONAL_CV_PATH` env
  // vars — Pushkar's own CV. Found live, 2026-09-04: without this, her tracked
  // rows (i.e. her whole queue) would have scored gap-overlap against his
  // skills, not hers.
  tracks: {
    fpa: {
      id: "fpa",
      name: "FP&A / Business Controlling",
      cvPath: "/opt/founderos-data/cv/cv-wife-base.md",
      // Her current role (HBS: management reporting, business case modelling,
      // FTE/headcount planning, Power BI dashboards) and the CV's own title.
      // Strongest direct fit — live experience, not just coursework.
      titles: [
        "FP&A Analyst:*",
        "Financial Planning & Analysis:*",
        "Financial Planning and Analysis:*",
        "Business Controller:*",
        "Business Controller Analyst:*",
        "Finance Business Partner:*",
        "Business Finance Partner:*",
        "Business Finance Analyst:*",
        "Financial Analyst:*",
        "Finance Analyst:*",
        "Financial Controller:*",
        "Management Accountant:*",
        "Reporting Analyst:*",
        "Financial Reporting Analyst:*",
        "Accounting and Reporting Analyst:*",
        "Finance Consultant:*",
        "Financial Consultant:*",
        // Founder-supplied list, 2026-09-04: "Business development" reads as
        // sales/BD elsewhere, but scoped to Finance it names a distinct,
        // real title (corporate-finance-adjacent growth/partnership analysis),
        // not the generic bare word — kept as the two-word compound only.
        "Business Development Analyst:*",
      ],
      classifyTerms: [
        "fp&a",
        "fp&a analyst",
        "financial planning and analysis",
        "business controller",
        "business controller analyst",
        "finance business partner",
        "business finance partner",
        "business finance",
        "financial analyst",
        "finance analyst",
        "financial controller",
        "management accountant",
        "reporting analyst",
        "financial reporting",
        "accounting and reporting",
        "finance consultant",
        "financial consultant",
        "business development analyst",
      ],
    },
    "finance-ops": {
      id: "finance-ops",
      name: "Finance Operations (RTR / OTC / PTP) / Credit / Tax & Treasury",
      cvPath: "/opt/founderos-data/cv/cv-wife-base.md",
      // Founder-supplied list, 2026-09-04. Distinct shared-services discipline
      // from FP&A, and a strong fit on her CURRENT role: HBS Finance Business
      // Services is exactly RTR/OTC/PTP-adjacent territory. Researched against
      // live postings, not guessed — RTR/Record-to-Report, OTC/Order-to-Cash and
      // PTP/Procure-to-Pay are the three named shared-services process areas
      // (confirmed via Accenture, SAP process docs); "transactional finance" is
      // a team/function name more than a standalone title, so it is a
      // classifyTerm here rather than a `titles` entry. "Due diligence analyst"
      // and "customer due diligence analyst" are established NL listings
      // (efinancialcareers.nl, togetherabroad.nl) distinct from her existing
      // compliance-kyc CDD titles — kept here because due diligence in this
      // context is transaction/credit-side, not AML-side.
      titles: [
        "RTR Analyst:*",
        "Record to Report Analyst:*",
        "OTC Analyst:*",
        "Order to Cash Analyst:*",
        "PTP Analyst:*",
        "Procure to Pay Analyst:*",
        "Credit Analyst:*",
        "Credit Review Analyst:*",
        "Tax Analyst:*",
        "Treasury Analyst:*",
        "Due Diligence Analyst:*",
        "Customer Due Diligence Analyst:*",
      ],
      classifyTerms: [
        // Bare 3-letter acronyms deliberately excluded from classifyTerms
        // (whole-word match against free-text descriptions, not just titles) —
        // "OTC" collides with over-the-counter trading/pharma, "PTP" and "RTR"
        // are common enough elsewhere to risk noise. The full phrases below are
        // unambiguous; the acronym forms still work via `titles`' substring
        // match against the posting's own title text.
        "record to report",
        "order to cash",
        "procure to pay",
        "transactional finance",
        "credit analyst",
        "credit review",
        "tax analyst",
        "treasury analyst",
        "due diligence",
        "customer due diligence",
      ],
    },
    "compliance-kyc": {
      id: "compliance-kyc",
      name: "Regulatory Compliance / KYC-AML",
      cvPath: "/opt/founderos-data/cv/cv-wife-base.md",
      // 22 months across two roles at TIDE — her second-strongest direct fit,
      // and a distinct job market from FP&A, not a subset of "auditor".
      titles: [
        "KYC Analyst:*",
        "AML Analyst:*",
        "KYC/AML Analyst:*",
        "CDD Analyst:*",
        "Compliance Analyst:*",
        "Anti-Money Laundering Analyst:*",
        "KYC Specialist:*",
        "Client Onboarding Specialist:*",
        "Regulatory Operations:*",
      ],
      classifyTerms: [
        "kyc analyst",
        "aml analyst",
        "cdd analyst",
        "compliance analyst",
        "anti-money laundering",
        "kyc specialist",
        "client onboarding",
        "kyc",
        "aml",
        "cdd",
      ],
    },
    auditor: {
      id: "auditor",
      name: "Auditor / Internal Controls",
      cvPath: "/opt/founderos-data/cv/cv-wife-base.md",
      // Matches her MSc major (Auditing) rather than direct work history —
      // ranked below fpa and compliance-kyc for that reason.
      titles: [
        "Internal Auditor:*",
        "Junior Internal Auditor:*",
        "Junior Audit Associate:*",
        "Audit Associate:*",
        "Audit Assistant:*",
        "External Auditor:*",
        "Statutory Auditor:*",
        "Forensic Auditor:*",
        "Forensic Accountant:*",
        "Risk & Controls Analyst:*",
        "Financial Risk Analyst:*",
        "Internal Controls Analyst:*",
      ],
      classifyTerms: [
        "internal auditor",
        "junior internal auditor",
        "junior audit associate",
        "audit associate",
        "audit assistant",
        "external auditor",
        "statutory audit",
        "forensic audit",
        "forensic accountant",
        "auditor",
        "risk and controls",
        "financial risk",
        "internal controls analyst",
      ],
    },
    accountant: {
      id: "accountant",
      name: "Accountant / General Ledger",
      cvPath: "/opt/founderos-data/cv/cv-wife-base.md",
      // Weakest direct fit — no dedicated bookkeeping role on her CV, only
      // IFRS/statutory-reporting exposure via HBS and coursework. Kept as the
      // widest net, lowest priority.
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
    },
  },

  trackPriority: ["fpa", "finance-ops", "compliance-kyc", "auditor", "accountant"],
  skillsDictionaryName: "finance",
  baseCvPath: "/opt/founderos-data/cv/cv-wife-base.md",
};
