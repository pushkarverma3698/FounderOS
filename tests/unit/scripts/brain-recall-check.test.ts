/**
 * AG-066 Part A: the brain recall check. Pure scoring and an injected-search runner are tested here at zero cost;
 * the live run against the prod brain happens in the brain-sync workflow.
 */
import { describe, it, expect } from "vitest";
import { evaluateRecall, formatReport, parseCases, runRecall, type RecallCase } from "../../../scripts/brain-recall-check.js";

const promote: RecallCase = { q: "how do we promote beta to main", project: "founderos", expect: "BRANCHING-STRATEGY" };
const pipeline: RecallCase = { q: "coding pipeline", project: "founderos", expect: "opendots-migration", forbid: "coding-pipeline-v2" };
const cases: RecallCase[] = [promote, pipeline];

describe("evaluateRecall", () => {
  it("hits when any top-k source contains the expected substring", () => {
    expect(evaluateRecall(promote, ["docs/ROADMAP.md", "docs/antigravity/BRANCHING-STRATEGY.md"]).hit).toBe(true);
  });
  it("misses when the expected substring is absent", () => {
    expect(evaluateRecall(promote, ["docs/ROADMAP.md"]).hit).toBe(false);
  });
  it("misses when a forbidden source is in the top-k even though the expected one is too", () => {
    const r = evaluateRecall(pipeline, ["docs/plans/2026-10-10-opendots-migration.md", "docs/plans/2026-09-30-coding-pipeline-v2.md"]);
    expect(r.hit).toBe(false);
    expect(r.reason).toMatch(/forbidden/);
  });
  it("only looks at the first k sources", () => {
    expect(evaluateRecall(promote, ["a", "b", "c", "BRANCHING-STRATEGY"], 3).hit).toBe(false);
  });
});

describe("runRecall", () => {
  it("passes when every case hits", async () => {
    const search = async (c: RecallCase) => ({
      sources: c === promote ? ["docs/antigravity/BRANCHING-STRATEGY.md"] : ["docs/plans/2026-10-10-opendots-migration.md"],
    });
    const out = await runRecall(cases, search, 3);
    expect(out.hits).toBe(2);
    expect(out.total).toBe(2);
    expect(formatReport(out, 3)).toContain("recall@3 = 2/2");
  });
  it("reports the miss with what came back", async () => {
    const search = async () => ({ sources: ["docs/ROADMAP.md"] });
    const out = await runRecall(cases, search, 3);
    expect(out.hits).toBe(0);
    const report = formatReport(out, 3);
    expect(report).toContain("MISS");
    expect(report).toContain("how do we promote beta to main");
    expect(report).toContain("docs/ROADMAP.md");
  });
  it("counts a search error as a miss and names the error", async () => {
    const search = async () => ({ error: "embed: ollama down" });
    const out = await runRecall(cases, search, 3);
    expect(out.hits).toBe(0);
    expect(formatReport(out, 3)).toContain("ollama down");
  });
});

describe("parseCases", () => {
  it("accepts the golden file shape", () => {
    expect(parseCases({ baseline: 1, cases: [promote] }).cases).toHaveLength(1);
  });
  it("rejects a case with no expect", () => {
    expect(() => parseCases({ baseline: 1, cases: [{ q: "x", project: "founderos" }] })).toThrow();
  });
});
