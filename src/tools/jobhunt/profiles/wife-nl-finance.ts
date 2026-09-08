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
 * PERMIT — CORRECTED by the founder, 2026-09-08. The earlier note here said
 * "she's on zoekjaar" (2026-09-04) and that was wrong in a way that matters:
 *
 *   "she will start when the offer lands, then only she will apply for her
 *    zoekjaar, as she has 3 years of time to apply the zoekjaar."
 *
 * So she does NOT hold an orientation-year permit today. She holds the RIGHT to
 * apply for one, inside a three-year window, and will do so once an offer exists.
 *
 * `zoekjaar` still leads `permitBases`, and the reason is unchanged: it is the
 * basis that makes a Dutch role REACHABLE, which is the question screening asks.
 * Screening her under `hsm` alone applies the recognised-sponsor register to
 * every Dutch employer and rejects most of a market she can lawfully enter — the
 * defect this ordering was introduced to fix. What changes is the tense: the
 * evidence text must read as "she will apply for the orientation year once an
 * offer lands", never as a permit she is holding now. See permit-routes.ts.
 *
 * ⚠ OPEN, AND IT DECIDES A LEGAL FLOOR. The IND *verlaagd salariscriterium*
 * (€3,122/month, vs €4,357 standard) applies to someone switching to a highly
 * skilled migrant permit within three years of completing a Dutch orientation
 * year OR obtaining a qualifying degree. `screen.ts` currently selects it from
 * `permitBases.includes("zoekjaar")` — a permanent property of the profile — so
 * it can never expire. Making it correct needs a DATE nobody has supplied yet:
 * when her three-year window opened. Until then the reduced figure is applied on
 * the founder's stated plan, and the failure direction is the silent-permissive
 * one (see docs/sessions/2026-09-08-jobhunt-supply-audit.md, fix L-1).
 *
 * INDIA — confirmed by the founder, 2026-09-08: she has the right to work in
 * India. `india-local` is therefore a held basis, not an assumption.
 *
 * NOT CONFIRMED, and therefore not asserted anywhere: she has never held a
 * partner permit, so that basis is deliberately absent.
 */

import type { JobSearchProfile } from "../profile-config.js";
import { INDIA_MARKET } from "./markets.js";

const WIFE_CV_PATH = process.env["WIFE_CV_PATH"] ?? "/opt/founderos-data/cv/cv-wife-base.md";

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

  // `india-local` added 2026-09-08 on the founder's own words: "Tashi will also
  // apply in india", and her right to work there CONFIRMED by him the same day.
  // A declared fact about a person — never inferred — and it must be BOTH here
  // and in `targetCountries`: the market decides whether an Indian posting
  // survives `filterCandidates` at all, the basis decides whether it is
  // screenable once it does. Her 56 existing `india-local` rows are what one
  // without the other looks like — fetched, screened, and rejected as "not a
  // market you have a legal basis for".
  //
  // Kept LAST only because the ordering is strongest-commitment-first and the
  // relocation is the goal; it is a fully held basis, not a provisional one.
  permitBases: ["zoekjaar", "hsm", "india-local"],

  // Display copies of the criteria.ts figures, for prompt text only. The binding
  // floor is looked up by date and dob in criteria.ts. No IND floor attaches on
  // the zoekjaar basis at all; on `hsm` the reduced criterion currently applies
  // (see the ⚠ note in this file's header — that selection is not yet dated).
  under30MonthlyEurFloor: 4357,
  over30MonthlyEurFloor: 5942,

  // `minInrLpaFloor` is DELIBERATELY ABSENT, and its absence is load-bearing.
  // The ₹15 LPA line is the founder's own preference, chosen by him from stated
  // options on 2026-08-01 (pay-india.ts says so in as many words) and pitched at
  // the tech market. Until 2026-09-08 `screen.ts` read it as
  // `profile.minInrLpaFloor ?? 15`, so declaring nothing meant inheriting his —
  // which for a finance analyst at 2.4 years would flag essentially every Indian
  // posting she saw, and a flagged row lands in ASK, which the free lane's alert
  // never announces. Her India lane would have been silent on a number nobody set
  // for her. `screenIndianPay` now takes `null` and says the line is unset rather
  // than borrowing one. Set this the day the founder states a figure.
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
    // Netherlands stays FIRST: `marketOf`/`MARKET_ORDER` render the brief in
    // this order, and the relocation is what the Dutch lane is for.
    INDIA_MARKET,
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
      cvPath: WIFE_CV_PATH,
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
      cvPath: WIFE_CV_PATH,
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
      //
      // "Finance Operations Specialist" / "Finance Operations Analyst" added
      // 2026-09-07, and these two ONLY. They are not a guess about what she might
      // also like: the track-coverage audit that day classified 4,511 real
      // postings against this profile, and of the 174 Dutch postings the
      // classifier dropped, exactly one was both finance-shaped and inside her
      // 0-4-year range — "Finance Operations Specialist" in Utrecht. Every other
      // NL miss was a CFO, a Director or a Head-of role far above 2.4 years, or a
      // quant-risk role outside these tracks. The measurement is the whole reason
      // nothing else was added with them; the same audit is what says her lane's
      // problem is supply, not vocabulary.
      titles: [
        "Finance Operations Specialist:*",
        "Finance Operations Analyst:*",
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
        "finance operations specialist",
        "finance operations analyst",
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
      cvPath: WIFE_CV_PATH,
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
      // "cdd" REMOVED as a bare acronym, 2026-09-08. In French postings CDD is
      // *contrat à durée déterminée* — the standard fixed-term contract — and it
      // appears in the TITLE of every such vacancy, so `matchesAsWholeWord` found
      // it flanked by spaces every time. Measured on prod that day: three Michael
      // Kors shop-floor vacancies in Paris and Toulon classified into this track,
      // and "Vendeur(se) avec expérience CDD 28h" reached brief_rank 2 of an `ask`
      // section that had three ranked rows in total.
      //
      // Costs nothing to drop: "CDD Analyst:*" stays in `titles` above, which is a
      // substring match against the posting's own title and does not fire on the
      // bare acronym. "kyc" and "aml" stay — neither is a common word in a
      // European job title. This is the same rule `finance-ops` already states for
      // OTC/PTP/RTR, applied to the track that was missed.
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
      ],
    },
    auditor: {
      id: "auditor",
      name: "Auditor / Internal Controls",
      cvPath: WIFE_CV_PATH,
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
      cvPath: WIFE_CV_PATH,
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
  baseCvPath: WIFE_CV_PATH,
};
