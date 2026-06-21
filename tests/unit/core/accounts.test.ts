import { describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_KEY,
  DEPARTMENT_ACCOUNT_DEFAULTS,
  defaultEnvKey,
  defaultGwsProfileDir,
  resolveAccountKey,
} from "../../../src/core/accounts.js";

describe("resolveAccountKey", () => {
  it("uses explicit account_key when valid", () => {
    expect(resolveAccountKey("google", { account_key: "personal" })).toBe("personal");
  });

  it("routes sales email to turicks", () => {
    expect(resolveAccountKey("google", { department: "sales" })).toBe("turicks");
  });

  it("routes jobhunt email to personal", () => {
    expect(resolveAccountKey("google", { department: "jobhunt" })).toBe("personal");
  });

  it("routes marketing linkedin to turicks", () => {
    expect(resolveAccountKey("linkedin", { department: "marketing" })).toBe("turicks");
  });

  it("falls back to turicks when department unknown", () => {
    expect(resolveAccountKey("google", { department: "unknown_dept" })).toBe(DEFAULT_ACCOUNT_KEY);
  });

  it("department defaults cover all outbound departments", () => {
    expect(DEPARTMENT_ACCOUNT_DEFAULTS["sales"]?.google).toBe("turicks");
    expect(DEPARTMENT_ACCOUNT_DEFAULTS["jobhunt"]?.google).toBe("personal");
    expect(DEPARTMENT_ACCOUNT_DEFAULTS["marketing"]?.instagram).toBe("turicks");
  });
});

describe("defaultEnvKey", () => {
  it("names per-account linkedin token env vars", () => {
    expect(defaultEnvKey("linkedin", "ACCESS_TOKEN", "personal")).toBe("LINKEDIN_ACCESS_TOKEN_PERSONAL");
  });

  it("names per-account github token env vars", () => {
    expect(defaultEnvKey("github", "GITHUB_TOKEN", "personal")).toBe("GITHUB_TOKEN_PERSONAL");
  });
});

describe("defaultGwsProfileDir", () => {
  it("isolates gws profiles per account", () => {
    expect(defaultGwsProfileDir("turicks")).toContain("/accounts/turicks/gws");
    expect(defaultGwsProfileDir("personal")).toContain("/accounts/personal/gws");
  });
});
