import { describe, expect, it } from "vitest";
import { reorderForPosting, sameContent } from "../../../src/tools/jobhunt/cv-reorder.js";
import { pickClosestTrack } from "../../../src/tools/jobhunt/track-pick.js";

const CV = `# Pushkar Verma

## SUMMARY

Engineer.

## SKILLS

**Languages:** Go, Python (FastAPI, Django), TypeScript
**Cloud:** AWS, Docker, Kubernetes

## EXPERIENCE

### Acme (2022-2024)

- Built dashboards in Excel for finance
- Shipped a TypeScript API on AWS with Docker
- Wrote Python services
  with a continuation line

### Beta (2020-2022)

- Ran standups
- Tuned Kubernetes clusters
`;

describe("reorderForPosting", () => {
  const out = reorderForPosting(CV, ["TypeScript", "Kubernetes", "AWS"]);

  it("puts matched skills first on each skills line and keeps the rest", () => {
    expect(out).toContain("**Languages:** TypeScript, Go, Python (FastAPI, Django)");
    expect(out).toContain("**Cloud:** AWS, Kubernetes, Docker");
  });

  it("puts matched bullets first inside each role only", () => {
    const acme = out.indexOf("Shipped a TypeScript API");
    expect(acme).toBeLessThan(out.indexOf("Built dashboards"));
    expect(out.indexOf("Tuned Kubernetes")).toBeLessThan(out.indexOf("Ran standups"));
    expect(out.indexOf("Beta (2020-2022)")).toBeGreaterThan(out.indexOf("Wrote Python services"));
  });

  it("keeps a continuation line with its bullet", () => {
    expect(out).toContain("- Wrote Python services\n  with a continuation line");
  });

  it("never adds or drops a bullet or skill", () => {
    expect(sameContent(CV, out)).toBe(true);
    expect(out.split("\n")).toHaveLength(CV.split("\n").length);
  });

  it("sameContent catches an added or changed item", () => {
    expect(sameContent(CV, CV.replace("Go,", "Go, Rust,"))).toBe(false);
    expect(sameContent(CV, CV.replace("Ran standups", "Led standups"))).toBe(false);
  });

  it("is a no-op without matches", () => {
    expect(reorderForPosting(CV, [])).toBe(CV);
  });
});

describe("pickClosestTrack", () => {
  const jd = "We need Kubernetes, Docker and AWS experience.";
  const cvs = [
    { track: "ai", text: "LangChain, RAG, Python" },
    { track: "backend", text: "Kubernetes, Docker, AWS, Go" },
  ];
  it("picks the CV with the most overlap", () => {
    expect(pickClosestTrack(jd, cvs, "ai")?.track).toBe("backend");
  });
  it("keeps the preferred track on a tie and returns null for no CVs", () => {
    expect(pickClosestTrack("Nothing technical here.", cvs, "backend")?.track).toBe("backend");
    expect(pickClosestTrack(jd, [], "ai")).toBeNull();
  });
});
