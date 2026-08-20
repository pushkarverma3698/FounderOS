/**
 * Unit tests — the IND sponsor-board probe's slug generation.
 *
 * The three real cases below are the ones the live probe actually confirmed
 * on 2026-08-20: `recruitee/dalsem` = Dalsem B.V., `recruitee/netconomy` =
 * Netconomy Netherlands B.V., `recruitee/ravo` = Ravo Holding B.V. — a wrong
 * slug here silently produces a wrong board later, and this is the only test
 * that would ever catch a regression in that generation logic before it costs
 * a live probe run.
 */

import { describe, it, expect } from "vitest";
import { strictSlug } from "../../../scripts/probe-sponsor-boards.js";

describe("strictSlug", () => {
  it("strips B.V. — a real confirmed hit", () => {
    expect(strictSlug("Dalsem B.V.")).toBe("dalsem");
  });

  it("strips a trailing country name — a real confirmed hit", () => {
    expect(strictSlug("Netconomy Netherlands B.V.")).toBe("netconomy");
  });

  it("strips Holding and B.V. together — a real confirmed hit", () => {
    expect(strictSlug("Ravo Holding B.V.")).toBe("ravo");
  });

  it("strips N.V.", () => {
    expect(strictSlug("Acme N.V.")).toBe("acme");
  });

  it("lowercases and dashes multi-word names", () => {
    expect(strictSlug("Blue Ocean Engineering B.V.")).toBe("blue-ocean-engineering");
  });

  it("collapses punctuation and whitespace into single dashes", () => {
    expect(strictSlug("Van der Berg & Zonen B.V.")).toBe("van-der-berg-zonen");
  });

  it("does not produce a leading or trailing dash", () => {
    expect(strictSlug("B.V. Acme")).not.toMatch(/^-|-$/);
  });

  it("never throws on an empty or punctuation-only name", () => {
    expect(() => strictSlug("")).not.toThrow();
    expect(strictSlug("")).toBe("");
    expect(strictSlug("...")).toBe("");
  });
});
