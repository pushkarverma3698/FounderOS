/**
 * Unit tests for per-thread active-company tracking.
 * Pure map accessors — no I/O (rule #16).
 */

import { describe, it, expect } from "vitest";
import {
  getActiveCompany,
  setActiveCompany,
  clearActiveCompany,
  parseCompanyArg,
} from "../../../src/gateway/active-company.js";
import { DEFAULT_COMPANY_KEY } from "../../../src/core/companies.js";

describe("getActiveCompany", () => {
  it("defaults an unseen chat to the boot tenant", () => {
    expect(getActiveCompany("chat-unseen-1")).toBe(DEFAULT_COMPANY_KEY);
  });
});

describe("setActiveCompany", () => {
  it("switches a chat to a known company (case-insensitive, trimmed)", () => {
    expect(setActiveCompany("chat-set-1", "  NAGGAR ")).toBe(true);
    expect(getActiveCompany("chat-set-1")).toBe("naggar");
  });

  it("rejects an unknown company and leaves the chat unchanged", () => {
    expect(setActiveCompany("chat-set-2", "acme")).toBe(false);
    expect(getActiveCompany("chat-set-2")).toBe(DEFAULT_COMPANY_KEY);
  });

  it("isolates state per chat", () => {
    setActiveCompany("chat-iso-a", "naggar");
    expect(getActiveCompany("chat-iso-a")).toBe("naggar");
    expect(getActiveCompany("chat-iso-b")).toBe(DEFAULT_COMPANY_KEY);
  });
});

describe("clearActiveCompany", () => {
  it("resets a chat back to the default tenant", () => {
    setActiveCompany("chat-clear-1", "naggar");
    clearActiveCompany("chat-clear-1");
    expect(getActiveCompany("chat-clear-1")).toBe(DEFAULT_COMPANY_KEY);
  });
});

describe("parseCompanyArg", () => {
  it("normalizes a present arg to lowercase, trimmed", () => {
    expect(parseCompanyArg("  Naggar ")).toBe("naggar");
  });

  it("returns undefined for empty/whitespace/missing args", () => {
    expect(parseCompanyArg("")).toBeUndefined();
    expect(parseCompanyArg("   ")).toBeUndefined();
    expect(parseCompanyArg(undefined)).toBeUndefined();
  });
});
