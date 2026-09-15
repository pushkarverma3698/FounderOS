/**
 * Unit tests — the title-LEVEL gate.
 *
 * Founder direction, 2026-09-15: "make sure too senior roles doesn't appear for
 * both as they are useless and CV will not get Screened."
 *
 * WHY A TITLE GATE NOW, when `experience.ts` explicitly refuses to be one.
 * That refusal (founder correction, 2026-08-02) was against flagging Director/VP
 * titles as scope nobody asked for. This is the founder asking for it, and the
 * measured reason is that the years gate cannot cover the case:
 *
 *   · 21 of Pushkar's 122 actionable rows and 58 of Tashi's 124 state NO year
 *     figure at all, so `experienceGate` passes them whatever the title says.
 *     "Principal Architect - Cloud & AI Engineering" reached DO TODAY that way.
 *   · Where a figure IS stated it can be the wrong one. Prod row 32 (LinkedIn,
 *     "Staff Software Engineer (Applied AI)") stored the verdict
 *     "Asks for 2 year(s) — within reach of your ~3.5 shipped" while quoting
 *     "8+ years of software engineering experience, with 2+ years hands-on".
 *
 * Measured on the live brief the day this was written: 24 of Pushkar's 122
 * actionable rows and 25 of Tashi's 124 were L5-or-above — a fifth of both
 * queues spent on roles neither of them can be shortlisted for.
 *
 * THE FALSE POSITIVES ARE THE HARD HALF, and every one asserted below was found
 * in the real 2,383-row table rather than imagined. A title gate that eats
 * "Senior Associate" or "Business Partner" removes reachable roles silently,
 * which is the failure direction this pipeline has already been wrong in twice.
 */

import { describe, it, expect } from "vitest";
import {
  TITLE_LEVEL,
  classifyTitleLevel,
  levelGate,
} from "../../../src/tools/jobhunt/level.js";
import { PUSHKAR_PROFILE } from "../../../src/tools/jobhunt/profile-config.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";
import { isAskableRow, isStretchRow } from "../../../src/tools/jobhunt/brief-select.js";
import type { BriefRow } from "../../../src/tools/jobhunt/brief-row.js";
import type { Gate } from "../../../src/tools/jobhunt/gates.js";

describe("classifyTitleLevel — the ladder", () => {
  it("reads an unmodified title as mid", () => {
    for (const title of [
      "Software Engineer",
      "Data and AI Engineer",
      "FP&A Analyst II",
      "Financial Accountant",
      "KYC Operations Analyst",
      "Frontend Engineer - Growth team",
    ]) {
      expect(classifyTitleLevel(title), title).toBe(TITLE_LEVEL.MID);
    }
  });

  it("reads senior and its abbreviations as senior", () => {
    for (const title of [
      "Senior Software Engineer",
      "Sr Data Engineer (Python, SQL, AI Solutions)",
      "Sr. Financial Analyst",
      "Senior Accountant- Statutory Reporting",
    ]) {
      expect(classifyTitleLevel(title), title).toBe(TITLE_LEVEL.SENIOR);
    }
  });

  it("reads staff, principal, lead, architect and manager as above senior", () => {
    // Every one of these was sitting in a live DO TODAY or STRETCH section.
    for (const title of [
      "Staff Software Engineer (Applied AI)",
      "Principal Data Scientist 3",
      "Principal Architect - Cloud & AI Engineering",
      "AI Solution Architect",
      "Solution Architect - Agentic AI Platform",
      "Engineering Manager, SRE",
      "Technical Lead Engineer - Identity Platform & Microservices",
      "Senior Lead-AI Engineer",
      "Manager, Financial Planning and Analysis",
      "FP&A Manager",
      "Lead VAT Accountant",
      "Deputy Manager - General Ledger /Record to Report",
      "Associate Manager, FP&A",
    ]) {
      expect(classifyTitleLevel(title), title).toBe(TITLE_LEVEL.STAFF);
    }
  });

  it("reads director, head-of, chief and SVP as executive", () => {
    for (const title of [
      "Director, Credit Review",
      "Head of Data Engineering",
      "Chief Technology Officer",
      "Senior Manager - Business Finance",
      "Golang Software Engineering Lead - GenAI platforms - Senior Vice President",
      "Senior Manager-Data Engineer",
    ]) {
      expect(classifyTitleLevel(title), title).toBe(TITLE_LEVEL.EXEC);
    }
  });

  it("treats an Assistant Vice President as SENIOR, not an executive", () => {
    // Banking grades, not org charts. At Citi and ING an AVP is roughly a
    // 4-6 year individual contributor; reading the words "Vice President"
    // literally would discard a whole reachable band of the market. A plain
    // or SENIOR Vice President is the real executive grade and stays EXEC.
    expect(classifyTitleLevel("Senior Python Developer- Assistant Vice President")).toBe(
      TITLE_LEVEL.SENIOR,
    );
    expect(classifyTitleLevel("AVP - Financial Reporting")).toBe(TITLE_LEVEL.SENIOR);
    expect(classifyTitleLevel("Lead Java Software Engineer - Vice President")).toBe(
      TITLE_LEVEL.EXEC,
    );
  });

  it("does not read a consulting 'Senior Associate' as above senior", () => {
    // PwC/RSM/Deloitte grade ladders put Senior Associate at ~3-5 years — the
    // exact band both candidates are in. 17 PwC rows in the live brief carry it.
    expect(
      classifyTitleLevel("IN_Senior Associate_Generative AI Engineer_Advisory_Bangalore"),
    ).toBe(TITLE_LEVEL.SENIOR);
    expect(classifyTitleLevel("Senior Associate 1, Financial Due Diligence")).toBe(
      TITLE_LEVEL.SENIOR,
    );
  });

  it("does not read a 'Business Partner' as a firm partner", () => {
    // Measured false positive: "AMEA FC Commercial Finance Business Partner" is
    // an ordinary finance role, not an equity partner at a firm.
    expect(classifyTitleLevel("AMEA FC Commercial Finance Business Partner")).toBe(
      TITLE_LEVEL.MID,
    );
    expect(classifyTitleLevel("Finance Business Partner")).toBe(TITLE_LEVEL.MID);
    expect(classifyTitleLevel("HR Business Partner")).toBe(TITLE_LEVEL.MID);
  });

  it("does not read 'Lead Associate' or 'Lead Generation' as a lead role", () => {
    // WNS grades "Lead Associate" as a mid-level seat and states 3-5 years in
    // the title itself. "Lead generation" is a sales function, not a level.
    expect(
      classifyTitleLevel("General Ledger - Record To Report - Lead Associate 3 - 5 Years"),
    ).toBe(TITLE_LEVEL.MID);
    expect(classifyTitleLevel("Lead Generation Specialist")).toBe(TITLE_LEVEL.MID);
  });

  it("does not fire on a substring inside an ordinary word", () => {
    // "leadership", "management", "architecture" and "staffing" all contain a
    // ladder word and none of them is one.
    expect(classifyTitleLevel("Engineer, Leadership Tools")).toBe(TITLE_LEVEL.MID);
    expect(classifyTitleLevel("Data Engineer - Management Reporting")).toBe(TITLE_LEVEL.MID);
    expect(classifyTitleLevel("Software Engineer, Architecture Guild")).toBe(TITLE_LEVEL.MID);
    expect(classifyTitleLevel("Staffing Coordinator Analyst")).toBe(TITLE_LEVEL.MID);
  });

  it("is case-insensitive and survives punctuation the feeds actually emit", () => {
    expect(classifyTitleLevel("SR. STAFF SOFTWARE ENGINEER, SYSTEMS INFRASTRUCTURE")).toBe(
      TITLE_LEVEL.STAFF,
    );
    expect(classifyTitleLevel("DevOps Engineer (Senior/Staff)")).toBe(TITLE_LEVEL.STAFF);
    expect(classifyTitleLevel("Senior/Staff Engineer, Design Verification")).toBe(
      TITLE_LEVEL.STAFF,
    );
  });

  it("takes the HIGHEST level a title names, never the first", () => {
    // "Senior Lead-AI Engineer" and "Sr. Staff Software Engineer" both open with
    // the lower word. Reading left to right would pass them as senior.
    expect(classifyTitleLevel("Senior Lead-AI Engineer")).toBe(TITLE_LEVEL.STAFF);
    expect(classifyTitleLevel("Senior Staff Software Engineer, Agentic Platform")).toBe(
      TITLE_LEVEL.STAFF,
    );
  });
});

describe("levelGate — Pushkar (3.5 years): senior is fair game, staff is not", () => {
  const gateFor = (title: string) => levelGate(title, PUSHKAR_PROFILE);

  it("says nothing at all about a mid or senior title", () => {
    // Silence is the correct output. A gate line reading "✅ your level is fine"
    // on every row is noise wearing the costume of information.
    expect(gateFor("Senior Software Engineer")).toBeNull();
    expect(gateFor("Data and AI Engineer")).toBeNull();
  });

  it("rejects a staff-or-above title", () => {
    const gate = gateFor("Staff Software Engineer (Applied AI)");
    expect(gate?.status).toBe("reject");
    expect(gate?.gate).toBe("Level");
  });

  it("rejects an executive title", () => {
    expect(gateFor("Director, Credit Review")?.status).toBe("reject");
  });

  it("names the level and the years behind the refusal, in the founder's own terms", () => {
    // The evidence is the whole reason a reject is allowed to exist here: a row
    // removed without a readable reason is indistinguishable from a quiet market.
    const gate = gateFor("Principal Architect - Cloud & AI Engineering");
    expect(gate?.evidence).toContain("Principal Architect - Cloud & AI Engineering");
    expect(gate?.evidence).toMatch(/3\.5/);
    expect(gate?.evidence).toMatch(/staff|principal|level/i);
  });
});

describe("levelGate — Tashi (2.4 years): senior is the stretch, lead is not", () => {
  const gateFor = (title: string) => levelGate(title, WIFE_FINANCE_PROFILE);

  it("says nothing about a mid title", () => {
    expect(gateFor("FP&A Analyst II")).toBeNull();
    expect(gateFor("KYC Operations Analyst")).toBeNull();
  });

  it("FLAGS a senior title rather than passing or rejecting it", () => {
    // At 2.4 years a "Senior Accountant" is a real stretch, not a bar — the same
    // reasoning the years gate applies to a 5-6 year demand. It must survive to
    // the founder, in STRETCH, instead of vanishing.
    const gate = gateFor("Senior Financial Analyst");
    expect(gate?.status).toBe("flag");
    expect(gate?.evidence).toMatch(/2\.4/);
  });

  it("rejects Manager, Lead and Principal", () => {
    for (const title of [
      "Manager, Financial Planning and Analysis",
      "FP&A Manager",
      "Lead VAT Accountant",
      "Principal Financial Analyst",
      "Senior Manager - Business Finance",
    ]) {
      expect(gateFor(title)?.status, title).toBe("reject");
    }
  });

  it("does not reject the consulting and business-partner titles she can take", () => {
    expect(gateFor("Senior Associate 1, Financial Due Diligence")?.status).not.toBe("reject");
    expect(gateFor("AMEA FC Commercial Finance Business Partner")).toBeNull();
  });
});

describe("a Level flag is an application, not a question", () => {
  // The regression experience-stretch.test.ts was written about, one gate later.
  // When the years bar started FLAGGING instead of rejecting, nothing downstream
  // was adjusted and the rescued rows landed in ASK — whose only command writes
  // the employer a question. Asking "is the Senior title firm?" invites a
  // pre-emptive rejection on the exact gate this band argues is a stretch worth
  // taking, and it contradicts the gate's own evidence, which says to apply.
  const row = (gates: readonly Gate[]): BriefRow => ({
    id: "t1",
    company: "Nium",
    title: "Senior Reporting Analyst",
    track: "fpa",
    verdict: "flag",
    route: "zoekjaar",
    country: "NL",
    location: "Amsterdam, Netherlands",
    url: "https://example.com/1",
    overlap: { matched: ["Power BI"], missing: [], asked: 1, ratio: 1 },
    liveness: "live",
    gates,
    legacyGates: false,
    ageDays: 0,
  });

  const CLEARED: readonly Gate[] = [
    { gate: "Basis", status: "pass", evidence: "Orientation year." },
    { gate: "Salary", status: "pass", evidence: "Clears the criterion." },
  ];

  const LEVEL_FLAG = levelGate("Senior Reporting Analyst", WIFE_FINANCE_PROFILE) as Gate;

  it("puts a Level-only flag in STRETCH, carrying /draft", () => {
    expect(isStretchRow(row([...CLEARED, LEVEL_FLAG]))).toBe(true);
  });

  it("keeps a Level-only flag OUT of ASK", () => {
    expect(isAskableRow(row([...CLEARED, LEVEL_FLAG]))).toBe(false);
  });

  it("accepts a row flagged on BOTH the years and the level", () => {
    // Both say the same thing — the seat is above her — and neither is settled
    // by a message. Together they are still an application, not a question.
    const years: Gate = {
      gate: "Experience",
      status: "flag",
      evidence: "Asks for 5 years minimum; you have ~2.4 shipped.",
    };
    expect(isStretchRow(row([...CLEARED, years, LEVEL_FLAG]))).toBe(true);
  });

  it("still leaves a row flagged on the level AND a real question in ASK", () => {
    // The over-correction guard. An unstated salary IS a question an employer
    // can answer, so one message should settle it — that row belongs in ASK
    // even though it also carries a Level flag.
    const salary: Gate = {
      gate: "Salary",
      status: "flag",
      evidence: "The ad states no salary, so the permit floor cannot be checked.",
    };
    const mixed = row([CLEARED[0] as Gate, salary, LEVEL_FLAG]);
    expect(isStretchRow(mixed)).toBe(false);
    expect(isAskableRow(mixed)).toBe(true);
  });
});

describe("the ceiling is a property of the profile, never a constant", () => {
  it("gives the two candidates different verdicts on the identical title", () => {
    // The single assertion that proves the ceiling is read per candidate. A
    // hardcoded ladder would give "Senior X" the same answer for a 3.5-year
    // engineer and a 2.4-year analyst, and one of the two would be wrong.
    const title = "Senior Reporting Analyst";
    expect(levelGate(title, PUSHKAR_PROFILE)).toBeNull();
    expect(levelGate(title, WIFE_FINANCE_PROFILE)?.status).toBe("flag");
  });

  it("is pure — same title, same profile, same answer every time", () => {
    const a = levelGate("Staff Site Reliability Engineer", PUSHKAR_PROFILE);
    const b = levelGate("Staff Site Reliability Engineer", PUSHKAR_PROFILE);
    expect(a).toEqual(b);
  });
});
