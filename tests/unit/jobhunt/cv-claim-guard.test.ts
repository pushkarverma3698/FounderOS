/**
 * Unit tests — `verifyCvClaims`, the deterministic fact-check `tailorCv()` runs
 * before a tailored CV can leave the pipeline.
 *
 * WHY THIS EXISTS. Until this guard, `tailorCv()`'s only defense against
 * fabrication was a system-prompt instruction ("NEVER fabricate..."). A
 * 2026-08-25 measurement found 36 fabricated claims across 4 sampled tailored
 * CVs — invented Kubernetes, PyTorch, Domain-Driven Design and FastAPI
 * experience the base CV never states. This guard is the mechanism; these
 * tests are the proof it works AND the proof it doesn't over-block.
 *
 * The false-positive tests matter as much as the failure tests: this function
 * BLOCKS a real application from going out, so a guard that flags legitimate
 * paraphrasing costs a good candidate a real shot at a role.
 */

import { describe, it, expect } from "vitest";
import { verifyCvClaims } from "../../../src/tools/jobhunt/cv-claim-guard.js";

/** A base CV with a graduation year (2015) and an employment date (Jan 2020) so date checks have two distinct years to work with. */
const BASE_CV = [
  "# Pushkar Verma",
  "",
  "## Summary",
  "Backend engineer with experience in distributed systems, using Python and TypeScript.",
  "",
  "## Skills",
  "- Python, TypeScript, PostgreSQL, Docker, Node.js",
  "",
  "## Experience",
  "### Turicks — Founding Engineer",
  "Jan 2020 - Present",
  "- Built a LangGraph agent kernel on Node and Postgres.",
  "- Wrote a job pipeline in Python that polls hundreds of ATS boards.",
  "",
  "## Education",
  "### Bachelor of Science in Computer Science",
  "VU Amsterdam, 2015",
].join("\n");

describe("verifyCvClaims — passes grounded content", () => {
  it("passes a tailored CV that only restates the base CV", () => {
    const tailored = [
      "# Pushkar Verma",
      "",
      "## Summary",
      "Backend engineer focused on distributed systems, working in Python and TypeScript.",
      "",
      "## Skills",
      "- Python, TypeScript, PostgreSQL, Docker, Node.js",
      "",
      "## Experience",
      "### Turicks — Founding Engineer",
      "Jan 2020 - Present",
      "- Built a LangGraph-based agent kernel on Node and Postgres.",
      "- Wrote a Python job pipeline polling hundreds of ATS boards.",
      "",
      "## Education",
      "### Bachelor of Science in Computer Science",
      "VU Amsterdam, 2015",
    ].join("\n");

    expect(verifyCvClaims(tailored, BASE_CV)).toEqual({ ok: true });
  });

  it("passes a legitimate paraphrase that recombines facts from different sentences", () => {
    // The spec case: base CV states "Python" and "distributed systems" in
    // different sentences; a tailored CV combining them into one sentence is
    // truthful, not fabricated.
    const tailored = [
      "# Pushkar Verma",
      "",
      "## Summary",
      "5 years building distributed systems in Python.",
      "",
      "## Skills",
      "- Python, TypeScript, PostgreSQL, Docker, Node.js",
      "",
      "## Experience",
      "### Turicks — Founding Engineer",
      "Jan 2020 - Present",
      "- Built a LangGraph agent kernel on Node and Postgres.",
      "",
      "## Education",
      "### Bachelor of Science in Computer Science",
      "VU Amsterdam, 2015",
    ].join("\n");

    expect(verifyCvClaims(tailored, BASE_CV)).toEqual({ ok: true });
  });

  it("passes a technology restated under a different alias of the same dictionary term", () => {
    // Base CV says "Node.js"; tailored CV says "nodejs" — extractSkillTerms
    // maps both to the same canonical term, so this is not a new claim.
    const tailored = BASE_CV.replace("Node.js", "nodejs");
    expect(verifyCvClaims(tailored, BASE_CV)).toEqual({ ok: true });
  });

  it("passes a reworded but truthful title (defining role word still present on the CV)", () => {
    // "Software" must appear on the BASE CV too, or this would be exactly the
    // fabrication the next describe-block tests for — the base is amended
    // here, not the tailored copy, to prove the word is genuinely grounded.
    const base = BASE_CV.replace("## Summary\nBackend", "## Summary\nSoftware engineer. Backend");
    const tailored = base.replace(
      "### Turicks — Founding Engineer",
      "### Turicks — Founding Software Engineer",
    );

    expect(verifyCvClaims(tailored, base)).toEqual({ ok: true });
  });
});

describe("verifyCvClaims — catches fabricated technology claims", () => {
  it("fails on an invented technology, naming it specifically", () => {
    const tailored = BASE_CV.replace(
      "- Python, TypeScript, PostgreSQL, Docker, Node.js",
      "- Python, TypeScript, PostgreSQL, Docker, Node.js, Kubernetes",
    );

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "technology", claim: "Kubernetes" }),
    );
  });

  it("fails on multiple invented technologies from the real 2026-08-25 measurement, naming each", () => {
    const tailored = BASE_CV.replace(
      "- Python, TypeScript, PostgreSQL, Docker, Node.js",
      "- Python, TypeScript, PostgreSQL, Docker, Node.js, PyTorch, FastAPI, Domain-Driven Design",
    );

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    const claims = result.violations.map((v) => v.claim);
    expect(claims).toEqual(
      expect.arrayContaining(["PyTorch", "FastAPI", "Domain-Driven Design"]),
    );
  });
});

describe("verifyCvClaims — catches fabricated employer claims", () => {
  it("fails on an invented employer, naming it specifically", () => {
    const tailored = BASE_CV.replace(
      "### Turicks — Founding Engineer",
      "### Globex Corporation — Founding Engineer",
    );

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "employer", claim: "Globex Corporation" }),
    );
  });
});

describe("verifyCvClaims — catches fabricated / shifted dates", () => {
  it("fails on a shifted employment start date not stated anywhere in the base CV", () => {
    const tailored = BASE_CV.replace("Jan 2020 - Present", "Jan 2018 - Present");

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "date", claim: "Jan 2018" }),
    );
  });

  it("passes a date restated in a different but equivalent format", () => {
    // Same year (2020), different token shape — not a new claim.
    const tailored = BASE_CV.replace("Jan 2020 - Present", "01/2020 - Present");
    expect(verifyCvClaims(tailored, BASE_CV)).toEqual({ ok: true });
  });
});

describe("verifyCvClaims — catches fabricated degrees", () => {
  it("fails on an invented degree type not held anywhere per the base CV", () => {
    const tailored = BASE_CV.replace(
      "### Bachelor of Science in Computer Science",
      "### Master of Science in Computer Science",
    );

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "degree" }),
    );
  });

  it("fails on an invented certification named in the education section", () => {
    const tailored = BASE_CV.replace(
      "VU Amsterdam, 2015",
      "VU Amsterdam, 2015\n\nAWS Certified Solutions Architect",
    );

    const result = verifyCvClaims(tailored, BASE_CV);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.violations).toContainEqual(
      expect.objectContaining({ kind: "degree" }),
    );
  });
});
