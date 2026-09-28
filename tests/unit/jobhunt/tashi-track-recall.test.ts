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
 */

import { describe, it, expect } from "vitest";
import { classifyTrack } from "../../../src/tools/jobhunt/tracks.js";
import { WIFE_FINANCE_PROFILE as tashi } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";

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
