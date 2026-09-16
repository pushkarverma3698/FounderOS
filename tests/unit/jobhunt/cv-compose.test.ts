/**
 * Unit tests — the locked-body CV composer.
 *
 * Founder direction, 2026-09-15: "The CV only needs to change for the leftover
 * keywords and the Base CV is locked."
 *
 * WHAT WAS WRONG BEFORE. `tailorCv` asked the model to regenerate the ENTIRE CV
 * and re-verified the result with `verifyCvClaims`. Two consequences, both
 * measured:
 *
 *   · The base CV was not locked in any sense. The claim guard checks named
 *     technologies, employers, titles, dates and degrees; every line of prose
 *     around them was the model's to rewrite, differently on every run.
 *   · The whole document was at risk from one bad word. Prod 2026-09-07: 21 of
 *     22 tailoring attempts were rejected outright, each throwing away a
 *     complete CV over a handful of words. Against 2 applications ever sent.
 *
 * WHAT THIS DOES INSTEAD. Everything below the summary is copied byte for byte,
 * so the model can only ever affect the three lines it was asked to write, and
 * the claim guard can only ever fail on those three lines.
 *
 * THE TWO CVs HAVE DIFFERENT HEADINGS and that is not a detail: Pushkar's says
 * `## SUMMARY`, Tashi's says `## PROFILE`. A splitter that knew only the first
 * would have silently returned her whole CV as one unsplittable block.
 */

import { describe, it, expect } from "vitest";
import { composeCv, splitCv } from "../../../src/tools/jobhunt/cv-compose.js";

const PUSHKAR_CV = `# PUSHKAR VERMA
pushkar@example.com · +91-000 · github.com/pushkarverma3698

## SUMMARY

Engineer who ships production agent systems.

## PROJECTS

### FounderOS — production multi-agent kernel
- Built a deterministic kernel in TypeScript.

## SKILLS
Python, TypeScript, LangGraph
`;

const TASHI_CV = `# Tashi Goyal
goyaltashi7@example.com · +31-000 · linkedin.com/in/tashi-goyal

## PROFILE

Finance professional trained in auditing.

## EDUCATION

**MSc Accounting, Auditing & Control** — Erasmus University

## SKILLS
Excel, Power BI, SQL
`;

describe("splitCv — finds the summary whatever the CV calls it", () => {
  it("splits on ## SUMMARY", () => {
    const parts = splitCv(PUSHKAR_CV);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect(parts.heading).toBe("## SUMMARY");
    expect(parts.summary.trim()).toBe("Engineer who ships production agent systems.");
    expect(parts.head).toContain("# PUSHKAR VERMA");
    expect(parts.head).toContain("github.com/pushkarverma3698");
    expect(parts.body).toContain("## PROJECTS");
    expect(parts.body).toContain("## SKILLS");
  });

  it("splits on ## PROFILE, which is what the second candidate's CV says", () => {
    const parts = splitCv(TASHI_CV);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect(parts.heading).toBe("## PROFILE");
    expect(parts.summary.trim()).toBe("Finance professional trained in auditing.");
    expect(parts.body).toContain("## EDUCATION");
  });

  it("accepts the other spellings a CV actually uses", () => {
    for (const heading of ["## Professional Summary", "## About", "## Objective", "# Summary"]) {
      const cv = `# Name\ncontact\n\n${heading}\n\nOne line.\n\n## EXPERIENCE\nStuff\n`;
      const parts = splitCv(cv);
      expect(parts.ok, heading).toBe(true);
    }
  });

  it("REFUSES a CV with no summary section rather than guessing", () => {
    // The silent-failure direction. Returning the whole document as "body" would
    // mean the summary is never tailored and nothing says so; returning it as
    // "summary" would hand the model the entire CV to rewrite — the exact
    // behaviour this module exists to end.
    const parts = splitCv("# Name\ncontact\n\n## EXPERIENCE\n- did things\n");
    expect(parts.ok).toBe(false);
    if (parts.ok) return;
    expect(parts.error).toMatch(/summary/i);
  });

  it("REFUSES when the summary section is empty", () => {
    const parts = splitCv("# Name\ncontact\n\n## SUMMARY\n\n## EXPERIENCE\n- did things\n");
    expect(parts.ok).toBe(false);
  });

  it("takes only the FIRST summary heading when a CV repeats the word", () => {
    const cv =
      "# Name\ncontact\n\n## SUMMARY\n\nReal summary.\n\n## EXPERIENCE\n" +
      "- Wrote the executive summary for the board\n";
    const parts = splitCv(cv);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect(parts.summary.trim()).toBe("Real summary.");
    expect(parts.body).toContain("executive summary for the board");
  });
});

describe("composeCv — everything below the summary is byte-identical", () => {
  it("round-trips to the original when the summary is unchanged", () => {
    const parts = splitCv(PUSHKAR_CV);
    expect(parts.ok).toBe(true);
    if (!parts.ok) return;
    expect(composeCv(parts, parts.summary)).toBe(PUSHKAR_CV);
  });

  it("changes ONLY the summary when given a new one", () => {
    const parts = splitCv(PUSHKAR_CV);
    if (!parts.ok) throw new Error("split failed");
    const out = composeCv(parts, "Engineer who ships LLM systems in production.");

    // The one assertion this whole module exists for: every line outside the
    // summary survives unchanged, in order.
    const before = PUSHKAR_CV.split("\n");
    const after = out.split("\n");
    const changed = before.filter((line) => !after.includes(line));
    expect(changed).toEqual(["Engineer who ships production agent systems."]);

    expect(out).toContain("## PROJECTS");
    expect(out).toContain("- Built a deterministic kernel in TypeScript.");
    expect(out).toContain("Python, TypeScript, LangGraph");
    expect(out).toContain("Engineer who ships LLM systems in production.");
  });

  it("keeps the contact block above the summary intact", () => {
    // An ATS parses name, email and phone from the top of the document. A
    // composer that dropped or reordered them would break the parse before any
    // keyword matching happened.
    const parts = splitCv(TASHI_CV);
    if (!parts.ok) throw new Error("split failed");
    const out = composeCv(parts, "Finance analyst with FP&A and KYC experience.");
    expect(out).toContain("# Tashi Goyal");
    expect(out).toContain("goyaltashi7@example.com · +31-000 · linkedin.com/in/tashi-goyal");
    expect(out.indexOf("# Tashi Goyal")).toBeLessThan(out.indexOf("## PROFILE"));
  });

  it("strips a model's stray heading rather than nesting two of them", () => {
    // Models return "## SUMMARY\n\nText" about as often as "Text". Writing both
    // would produce a CV with the heading twice, which an ATS section-parser
    // reads as an empty section followed by an orphan paragraph.
    const parts = splitCv(PUSHKAR_CV);
    if (!parts.ok) throw new Error("split failed");
    const out = composeCv(parts, "## SUMMARY\n\nShips agent systems.");
    expect(out.match(/## SUMMARY/g)).toHaveLength(1);
    expect(out).toContain("Ships agent systems.");
  });

  it("is pure — same inputs, same bytes", () => {
    const parts = splitCv(TASHI_CV);
    if (!parts.ok) throw new Error("split failed");
    expect(composeCv(parts, "A summary.")).toBe(composeCv(parts, "A summary."));
  });
});
