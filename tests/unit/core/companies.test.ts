/**
 * Unit tests for the multi-business company registry.
 * Pure data + pure functions — no mocks, no I/O (rule #16).
 */

import { describe, it, expect } from "vitest";
import {
  COMPANY_PROFILES,
  DEFAULT_COMPANY_KEY,
  getCompany,
  isCompanyKey,
  buildCompanyContextBlock,
} from "../../../src/core/companies.js";

describe("company registry", () => {
  it("ships the default boot tenant (turicks) and a second business (naggar)", () => {
    expect(COMPANY_PROFILES["turicks"]).toBeDefined();
    expect(COMPANY_PROFILES["naggar"]).toBeDefined();
  });

  it("defaults the boot tenant to turicks", () => {
    expect(DEFAULT_COMPANY_KEY).toBe("turicks");
  });
});

describe("isCompanyKey", () => {
  it("accepts a known key (case-insensitive, trimmed)", () => {
    expect(isCompanyKey("naggar")).toBe(true);
    expect(isCompanyKey("  Naggar ")).toBe(true);
    expect(isCompanyKey("TURICKS")).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(isCompanyKey("acme")).toBe(false);
    expect(isCompanyKey("")).toBe(false);
  });
});

describe("getCompany", () => {
  it("resolves a known key", () => {
    expect(getCompany("naggar").displayName).toBe("Naggar Retreat");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(getCompany("  NAGGAR ").key).toBe("naggar");
  });

  it("falls back to the boot tenant for an unknown key (never throws)", () => {
    expect(getCompany("acme").key).toBe(DEFAULT_COMPANY_KEY);
  });

  it("falls back to the boot tenant when no key is given", () => {
    expect(getCompany().key).toBe(DEFAULT_COMPANY_KEY);
    expect(getCompany(undefined).key).toBe(DEFAULT_COMPANY_KEY);
  });
});

describe("buildCompanyContextBlock", () => {
  it("returns an EMPTY block for the default tenant (cache-stable, rule #20)", () => {
    expect(buildCompanyContextBlock(getCompany("turicks"))).toBe("");
  });

  it("emits an override block for a non-default company", () => {
    const block = buildCompanyContextBlock(getCompany("naggar"));
    expect(block).toContain("Naggar Retreat");
    expect(block).toContain("NOT Turicks");
    expect(block).toMatch(/NEVER invent/i);
  });

  it("never fabricates — defers specifics to the knowledge store", () => {
    const block = buildCompanyContextBlock(getCompany("naggar"));
    expect(block).toContain(getCompany("naggar").knowledgeStore);
    expect(block).toMatch(/Internal facts/i);
  });
});
