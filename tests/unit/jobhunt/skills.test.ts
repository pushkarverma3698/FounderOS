/**
 * Unit tests — skill-signal extraction.
 *
 * The frequency table is only worth reading if the extractor is stable and
 * honest. Two failure modes would quietly ruin it: counting mentions instead of
 * postings (verbose employers would write the table), and substring matching
 * (every "going" becomes a vote for Go). Both are asserted here.
 */

import { describe, it, expect } from "vitest";
import {
  extractSkillTerms,
  extractUnknownTerms,
  signalsForPosting,
} from "../../../src/tools/jobhunt/skills.js";

const terms = (text: string): string[] => extractSkillTerms(text).map((s) => s.term);

describe("extractSkillTerms", () => {
  it("finds canonical terms and their aliases", () => {
    expect(terms("We use Kubernetes and Postgres")).toEqual(
      expect.arrayContaining(["Kubernetes", "PostgreSQL"]),
    );
    expect(terms("Experience with k8s required")).toContain("Kubernetes");
  });

  it("counts a term once per posting, however many times it appears", () => {
    const repeated = "Kubernetes. Kubernetes! We love Kubernetes and k8s and Kubernetes.";
    expect(extractSkillTerms(repeated).filter((s) => s.term === "Kubernetes")).toHaveLength(1);
  });

  it("matches punctuation-heavy names that \\b cannot handle", () => {
    expect(terms("Strong C++ background")).toContain("C++");
    expect(terms("Built on .NET and C#")).toEqual(expect.arrayContaining([".NET", "C#"]));
    expect(terms("Owns the CI/CD pipeline")).toContain("CI/CD");
    expect(terms("Node.js services")).toContain("Node.js");
  });

  it("does not fire inside longer words", () => {
    // "rag" inside "ragged", and the reason short English words are banned as
    // aliases: a false positive here is indistinguishable from real demand.
    expect(terms("a ragged old codebase")).not.toContain("RAG");
    expect(terms("we are going to grow")).not.toContain("Go");
    expect(terms("Golang experience")).toContain("Go");
  });

  it("is case-insensitive", () => {
    expect(terms("KUBERNETES and TypeScript and langgraph")).toEqual(
      expect.arrayContaining(["Kubernetes", "TypeScript", "LangGraph"]),
    );
  });

  it("returns the same result for the same input", () => {
    const text = "Python, Docker, AWS, RAG, LangGraph, Terraform";
    expect(extractSkillTerms(text)).toEqual(extractSkillTerms(text));
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(extractSkillTerms("")).toEqual([]);
    expect(extractSkillTerms("   \n  ")).toEqual([]);
  });
});

describe("extractUnknownTerms", () => {
  it("catches CamelCase and acronym technology names the dictionary lacks", () => {
    const found = extractUnknownTerms("We run FooBarDB and use XYZQ internally");
    expect(found).toEqual(expect.arrayContaining(["FooBarDB", "XYZQ"]));
  });

  it("ignores ordinary capitalised words", () => {
    const found = extractUnknownTerms("The Amsterdam office. Our Team is great. Monday starts.");
    expect(found).toEqual([]);
  });

  it("ignores business and legal noise that recurs in every Dutch posting", () => {
    const found = extractUnknownTerms("Our BV in the EU. Contact HR about the KPI and GDPR.");
    expect(found).toEqual([]);
  });

  it("ignores terms the dictionary already knows", () => {
    expect(extractUnknownTerms("We use PyTorch and LangGraph")).toEqual([]);
  });

  it("excludes the employer's own name", () => {
    // A CamelCase brand passes the shape test and would otherwise be
    // indistinguishable from an emerging technology in the report.
    expect(extractUnknownTerms("TravelBase is hiring", "TravelBase")).toEqual([]);
    expect(extractUnknownTerms("TravelBase is hiring")).toContain("TravelBase");
  });

  it("reports a repeated unknown term once", () => {
    expect(extractUnknownTerms("ZorroDB ZorroDB ZorroDB")).toEqual(["ZorroDB"]);
  });
});

describe("signalsForPosting", () => {
  it("tags unknown candidates separately from dictionary terms", () => {
    const signals = signalsForPosting("We use Kubernetes and ZorroDB", "Acme");
    expect(signals).toEqual(
      expect.arrayContaining([
        { term: "Kubernetes", category: "infra" },
        { term: "ZorroDB", category: "unknown" },
      ]),
    );
  });
});

describe("unknown-term noise found in the first live run", () => {
  it("suppresses generic technical vocabulary that distinguishes nothing", () => {
    // All of these surfaced as "rising unknown technologies" on 2026-07-29.
    const noise = "We build an API with APIs over HTTP returning JSON. BI on a PC. CI and CD.";
    expect(extractUnknownTerms(noise)).toEqual([]);
  });

  it("still surfaces a genuine technology the dictionary lacked", () => {
    // SQLAlchemy was a real catch from the same run — it has since been promoted
    // into the dictionary, which is exactly the loop this pass exists to drive.
    expect(terms("Experience with SQLAlchemy")).toContain("SQLAlchemy");
  });
});
