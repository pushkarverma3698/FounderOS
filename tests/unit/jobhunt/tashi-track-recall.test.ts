/**
 * Tashi's track vocabulary against the Dutch finance titles it was missing.
 *
 * MEASURED, 2026-09-28. Every board in the registry marked NL (1,166) was
 * polled with the production adapters and her own filters were run over the
 * 39,287 postings. 53 survived the 30-day window; 21 of them were in the
 * Netherlands. Among the postings dropped as `off_track` at NL or unknown
 * locations, 144 had finance-shaped titles, and reading them by hand left 29
 * that fit a 2.4-year FP&A / KYC / audit candidate — more than the 21 the lane
 * kept. Every positive below is one of those real titles, verbatim.
 *
 * The 2026-09-07 audit that found only one such miss measured a tech-heavy
 * corpus. The registry has since gained Deloitte NL, BDO, PwC, Rabobank, NN,
 * Baker Tilly and RSM; against their postings the vocabulary is what binds.
 *
 * The negatives are the false positives the obvious widenings would buy —
 * bare "controller" (a chip-design role), bare "tax" (software sales),
 * "compliance specialist" (export control) — each found in the same sweep.
 *
 * English titles only. Dutch-titled roles (financieel analist, boekhouding …)
 * wait on how well she reads Dutch: ~3/4 of Dutch finance postings are
 * written in Dutch, and the Language gate reads a stated requirement, not the
 * language a posting is written in.
 *
 * PRECISION (S6, 2026-09-29). The same audit listed four titles that passed her
 * filters and should not, and the bottom of this file pins each one as rejected:
 * bare "auditor" (a medical-device notified body), bare "due diligence" (a
 * construction survey), a Portuguese title that matched only the "(FP&A)"
 * acronym, and a working-student role. Then the same live corpus, re-polled on
 * 2026-09-29 (37,371 postings on the 1,166 NL-marked boards), supplied the
 * neighbours of each: 2 more bare-"auditor" rows, 1 more due-diligence row,
 * 3 more internship titles that read as finance ("Stage IT Audit & Assurance").
 * The qualified forms that must SURVIVE the change are pinned too — a precision
 * fix that quietly costs recall on "IT Auditor" is a regression, not a fix.
 */

import { describe, it, expect } from "vitest";
import { classifyTrack } from "../../../src/tools/jobhunt/tracks.js";
import { filterCandidates } from "../../../src/tools/jobhunt/free-ingest-filters.js";
import { getProfile, PUSHKAR_PROFILE } from "../../../src/tools/jobhunt/profile-config.js";
import { WIFE_FINANCE_PROFILE as tashi } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import type { FreeCandidate } from "../../../src/tools/jobhunt/free-ats-source.js";

describe("Tashi — Dutch finance titles the 2026-09-28 sweep dropped as off-track", () => {
  it.each([
    // Big-4 / mid-tier firm entry roles — her MSc is in auditing
    ["Junior Consultant Internal Audit, Risk & Compliance", "auditor"], // BDO
    ["Analyst IT Audit & Assurance", "auditor"], // Deloitte NL
    ["Analyst Risk & Data Transformation in de Financiële Sector", "auditor"], // Deloitte NL
    ["Junior Consultant Tax - WO", "finance-ops"], // BDO
    ["Junior Consultant Transfer Pricing", "finance-ops"], // BDO
    ["Junior Consultant Tax Transfer Pricing", "finance-ops"], // BDO
    ["Analyst Tax MKB", "finance-ops"], // Deloitte NL
    ["Consultant Indirect Tax - Public Interest Entities Amsterdam", "finance-ops"], // PwC
    ["Tax Specialist – Reporting & Accounting", "finance-ops"], // Boskalis
    ["Tax Filing & Payments Associate", "finance-ops"],
    ["Junior Consultant Finance Strategy & Operations - ERP & Digital Finance", "fpa"], // Deloitte NL
    ["Consultant Finance, Publieke Sector", "fpa"], // PwC
    // Financial crime / compliance — her TIDE KYC years
    ["Financial Crime Compliance Specialist", "compliance-kyc"], // ING
    ["Compliance Officer - Growth Programs", "compliance-kyc"], // Adyen
    // Controlling / FP&A
    ["Assistant Controller", "fpa"], // IFS
    ["Regio Controller", "fpa"], // SWARCO
    ["Finance Specialist", "fpa"], // Rabobank
    ["Finance Officer", "fpa"], // De Brauw Blackstone Westbroek
    ["Senior Financial Control Specialist", "fpa"], // NN Group — stretch, the level gate decides
    ["Strategic Finance Associate", "fpa"],
    ["Finance & Data Analyst", "fpa"], // Insify
    // Finance operations
    ["Accounts Payable Specialist EMEA", "finance-ops"], // Topcon
    ["Accounts Receivable Specialist EMEA", "finance-ops"], // Topcon
    ["Finance Administrator", "finance-ops"], // Stryker
    ["Technical Accounting Analyst (Infrastructure)", "accountant"], // Cloudflare
    ["Senior Accounting Officer", "accountant"], // Eurofiber
    // Risk
    ["Risk Specialist", "auditor"], // Fastned
    ["Risk Officer", "auditor"], // AFS Energy
    ["Risk Analyst", "auditor"],
    // 2026-10-05 audit: titles still off-track in a live sweep of 490 Dutch postings
    ["Finance Support Specialist", "finance-ops"], // Adyen
    ["Internal Control Specialist", "auditor"], // Adyen
    ["Analyst Regulatory Risk & Compliance", "auditor"], // Deloitte NL
    ["Operations Controller", "fpa"], // Flexport
    ["Senior Consultant Corporate Finance", "fpa"], // BDO
    ["Risk Consultant Verzekeren", "auditor"], // Rabobank
  ])("%s → %s", (title, track) => {
    expect(classifyTrack(title, tashi)).toBe(track);
  });
});

describe("Tashi — the widenings that were NOT made, and why", () => {
  it.each([
    "Design of integrated logic controller for MTP Memory", // bare "controller"
    "Associate Account Manger Tax & Trade (DACH) German and English speaking", // bare "tax"
    "Senior Enterprise Account Executive Tax and Trade Swedish and English speaking",
    "Export Compliance Specialist (on-site)", // "compliance specialist"
    "Trade Compliance Coordinator (Customer Onsite)",
    "Quality Assurance Officer for Export", // bare "assurance"
    "Engineering Technician 4, Quality Assurance",
    "Workday Reporting Specialist", // "reporting specialist" — HRIS, not finance
    "Payroll Specialist", // not one of her tracks
    "Werkstudent - Tax",
  ])("%s stays unclassified", (title) => {
    expect(classifyTrack(title, tashi)).toBeNull();
  });
});

// ── PRECISION ────────────────────────────────────────────────────────────────

/** The four titles under "Precision noise already in her queue" in the 2026-09-28 audit, verbatim. */
const AUDIT_PRECISION_NOISE = [
  "Medical Devices Auditor – High Risk Software", // bare "auditor"
  "Senior Technical Due Diligence Consultant – Bouwkundig Adviseur", // bare "due diligence": construction
  "Coordenador de Planejamento Financeiro e Análise (FP&A)", // Brazil, location unknown: only the acronym matched
  "Financial Controller – Working Student", // "financial controller" matched; the role is a student job
] as const;

describe("Tashi — the four titles the 2026-09-28 audit listed as precision noise are rejected", () => {
  it.each(AUDIT_PRECISION_NOISE)("%s stays unclassified", (title) => {
    expect(classifyTrack(title, tashi)).toBeNull();
  });

  it("rejects them for the profile the sweep actually runs, not just the object in this file", () => {
    // The registry stores the schema-PARSED profile, and Zod drops keys it does not know.
    // A field that exists on the literal but not in the schema passes every test above and
    // does nothing in production — which is exactly what this case would catch.
    const registered = getProfile("wife-nl-finance");
    for (const title of AUDIT_PRECISION_NOISE) {
      expect(classifyTrack(title, registered), title).toBeNull();
    }
  });
});

describe("Tashi — the same noise, measured live on 2026-09-29", () => {
  it.each([
    // bare "auditor" — not audit
    ["APSCA Certified Social Compliance Auditor"], // BSI Group, location blank
    ["Medical Devices Auditor - High Risk Software. Dutch speaking"], // BSI Group, Netherlands
    ["ISO 27001 Information Security Auditor (Sweden)"], // BSI Group
    ["Inbound Quality Control Auditor - Days"], // HelloFresh
    ["Auditor - 1st Shift"], // Nidec
    ["Cybersecurity Auditor (Remote)"], // Kyndryl
    // bare "due diligence" — not finance
    ["Technical Due Diligence Manager- Data Centers, EMEA"], // Nebius, Remote - Europe
    ["Commercial Due Diligence Engagement Lead and Director"], // Alpha FMC
    // working student / stage — a student job is not her level
    ["Financial Controller - Working Student"], // Trengo, Utrecht
    ["Stage IT Audit & Assurance"], // Deloitte Netherlands
    ["Stage Accountancy BGH Accountants & Adviseurs"], // BGH Accountants, Schijndel
    ["Stage - FP&A  Analyst (x/f/m) - mars 2027"], // Doctolib
  ])("%s stays unclassified", (title) => {
    expect(classifyTrack(title, tashi)).toBeNull();
  });
});

describe("Tashi — Dutch spellings of the same student/intern titles", () => {
  // Constructed from real Dutch patterns (RAVO "Meeloopstage Finance", Insify "Werkstudent
  // Customer Support", SKYTREE "Stagiair(e) Business Development", Centric "Meeloop- of
  // afstudeerstage") with a finance phrase from her vocabulary, because the real ones carry
  // none and so never reached the classifier's yes/no in the first place.
  it.each([
    "Werkstudent Financial Control",
    "Stagiair(e) Financial Planning",
    "Stagiaire Junior Controller",
    "Meeloopstage Financial Control",
    "Meewerkstage Financial Reporting",
    "Afstudeerstage Finance Controller",
    "Student-stage Financial Analyst",
  ])("%s stays unclassified", (title) => {
    expect(classifyTrack(title, tashi)).toBeNull();
  });
});

describe("Tashi — 'stage' and 'working student' are matched as whole words and phrases", () => {
  it("does not read 'backstage' or 'stages' as an internship", () => {
    // Same matcher the rest of the vocabulary uses: not flanked by a letter or digit.
    expect(classifyTrack("Financial Analyst, Backstage Ticketing", tashi)).toBe("fpa");
    expect(classifyTrack("Finance Analyst - Development Stages Reporting", tashi)).toBe("fpa");
  });

  it("does not read a title that merely mentions 'student' as a working-student role", () => {
    expect(classifyTrack("Financial Analyst, Student Loans", tashi)).toBe("fpa");
    expect(classifyTrack("Business Controller - Student Housing Portfolio", tashi)).toBe("fpa");
  });

  it("is case-insensitive, like every other term", () => {
    expect(classifyTrack("FINANCIAL CONTROLLER - WORKING STUDENT", tashi)).toBeNull();
    expect(classifyTrack("STAGE - Financial Control", tashi)).toBeNull();
  });
});

describe("Tashi — the qualified forms of 'auditor' and 'due diligence' still classify", () => {
  it.each([
    // live, 2026-09-29
    ["Senior IT Auditor", "auditor"], // Axon, Groupon, IMC
    ["IT Auditor", "auditor"], // PwC Malta
    ["Global Internal Auditor", "auditor"], // IMC, Amsterdam
    ["Senior Internal Auditor", "auditor"], // DENSO, Amsterdam
    ["Senior Consultant Tax - Due Diligence", "finance-ops"], // BDO, Breda: "consultant tax" carries it
    // live in another test, 2026-09-07
    ["Senior Associate 1, Financial Due Diligence", "finance-ops"], // level.test.ts
    // already pinned elsewhere, repeated so this block can be read alone
    ["Junior Internal Auditor", "auditor"],
    ["Due Diligence Analyst", "finance-ops"],
    ["Customer Due Diligence Analyst", "finance-ops"],
    // CONSTRUCTED: no live example on 2026-09-29. The canonical entry-level shapes, kept so
    // that dropping the bare word cannot cost recall on the roles an MSc in auditing is for.
    ["Junior Auditor", "auditor"],
    ["Financial Auditor", "auditor"],
    ["Client Due Diligence Specialist", "finance-ops"],
    ["Enhanced Due Diligence Specialist", "finance-ops"],
  ])("%s → %s", (title, track) => {
    expect(classifyTrack(title, tashi)).toBe(track);
  });
});

describe("Tashi's precision list is hers alone", () => {
  it("leaves Pushkar's classifier exactly as it was", () => {
    // His early-career titles are rejected at the Experience gate, on the record, as before.
    expect(classifyTrack("Backend Engineer - Working Student", PUSHKAR_PROFILE)).toBe("backend");
    expect(classifyTrack("Stage Frontend Developer", PUSHKAR_PROFILE)).toBe("frontend");
    expect(PUSHKAR_PROFILE.rejectTitleTerms).toBeUndefined();
  });
});

describe("Tashi — the free lane drops them at the filter, counted, not silently", () => {
  const NOW = new Date("2026-09-29T12:00:00.000Z");
  const board = { name: "Acme B.V.", ats: "greenhouse", token: "acme", markets: ["NL"] } as const;
  const candidate = (title: string): FreeCandidate => ({
    board,
    externalId: title,
    title,
    url: "https://boards.example/acme/1",
    location: "Amsterdam, Netherlands",
    postedAt: new Date(NOW.getTime() - 3_600_000),
    description: null,
  });

  it("counts them as off-track and says how many, and keeps the roles she can apply for", () => {
    const titles = [...AUDIT_PRECISION_NOISE, "Financial Analyst", "Senior IT Auditor"];
    const outcome = filterCandidates(titles.map(candidate), NOW, 720, tashi);

    expect(outcome.kept.map((c) => c.title)).toEqual(["Financial Analyst", "Senior IT Auditor"]);
    expect(outcome.counts.offTrack).toBe(AUDIT_PRECISION_NOISE.length);
    expect(outcome.notes.join(" ")).toContain(`${AUDIT_PRECISION_NOISE.length} postings matched none of Tashi Goyal's tracks`);
  });
});
