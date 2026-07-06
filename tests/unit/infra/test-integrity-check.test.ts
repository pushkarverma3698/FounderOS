/**
 * Test-integrity guard tests (CLAUDE.md rule #25 / TESTING-RULES.md Rule 15).
 *
 * Proves the analyzer actually catches self-serving/gamed test patterns —
 * and, just as importantly, that it stays quiet on realistic, well-formed
 * tests (no false positives against the house style used across this repo).
 */

import { describe, it, expect } from "vitest";
import { analyzeTestSource } from "../../../src/infra/test-integrity-check.js";

const FILE = "tests/unit/tools/fake.test.ts";

describe("analyzeTestSource — catches self-serving patterns", () => {
  it("flags a tautological assertion", () => {
    const src = `
      import { describe, it, expect } from "vitest";
      it("does the thing", () => {
        expect(true).toBe(true);
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "TAUTOLOGY")).toBe(true);
  });

  it("flags a test whose only assertion is toBeDefined", () => {
    const src = `
      it("returns something", () => {
        const result = doThing();
        expect(result).toBeDefined();
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "SOLE-WEAK-ASSERTION")).toBe(true);
  });

  it("does NOT flag toBeDefined when a strict assertion is also present", () => {
    const src = `
      it("returns the right shape", () => {
        const result = doThing();
        expect(result).toBeDefined();
        expect(result.id).toBe("abc123");
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "SOLE-WEAK-ASSERTION")).toBe(false);
  });

  it("flags an empty test body", () => {
    const src = `it("does something eventually", () => {});`;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "EMPTY-BODY")).toBe(true);
  });

  it("flags it.only with no exceptions", () => {
    const src = `
      // test-integrity-ignore: intentional, needed for this run
      it.only("just this one", () => {
        expect(1).toBe(1);
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "ONLY-LEFT-IN")).toBe(true);
  });

  it("flags describe.skip with no reason comment", () => {
    const src = `
      describe.skip("flaky suite", () => {
        it("does a thing", () => { expect(1).toBe(1); });
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "UNEXPLAINED-SKIP")).toBe(true);
  });

  it("does NOT flag .skip when a reason comment is present", () => {
    const src = `
      // test-integrity-ignore: flaky against real network, tracked in ISSUE-123
      describe.skip("flaky suite", () => {
        it("does a thing", () => { expect(1).toBe(1); });
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "UNEXPLAINED-SKIP")).toBe(false);
  });

  it("flags a test file mocking the exact unit it is named for", () => {
    const src = `
      import { vi } from "vitest";
      vi.mock("../../../src/tools/fake.js", () => ({ fakeTool: { invoke: vi.fn() } }));
      it("calls the tool", () => {
        expect(true).toBeTruthy();
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "SELF-MOCK")).toBe(true);
  });

  it("does NOT flag mocking a different module (dependency, not the unit under test)", () => {
    const src = `
      import { vi } from "vitest";
      vi.mock("../../../src/db/queries.js", () => ({ searchKnowledgeEntries: vi.fn() }));
      it("calls the tool", () => {
        expect(1).toBe(1);
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "SELF-MOCK")).toBe(false);
  });

  it("the test-integrity-ignore escape hatch suppresses a tautology finding", () => {
    const src = `
      // test-integrity-ignore: smoke test intentionally checks liveness only
      it("is alive", () => {
        expect(true).toBe(true);
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings.some((f) => f.rule === "TAUTOLOGY")).toBe(false);
  });

  it("a real, well-formed test produces zero findings (no false positives)", () => {
    const src = `
      import { describe, it, expect, vi } from "vitest";
      const mockSearchKnowledgeEntries = vi.fn();
      vi.mock("../../../src/db/queries.js", () => ({ searchKnowledgeEntries: mockSearchKnowledgeEntries }));

      describe("searchKnowledge", () => {
        it("returns success:false when API returns 200 with no id", async () => {
          mockSearchKnowledgeEntries.mockResolvedValue({ message: "Authentication token expired." });
          const result = await searchKnowledge.execute({ query: "x" });
          expect(result.success).toBe(false);
          expect(result.error).toContain("Authentication token expired.");
        });
      });
    `;
    const findings = analyzeTestSource(FILE, src);
    expect(findings).toEqual([]);
  });
});
