/**
 * Integration chain tests — no mocks on routing/credential resolution.
 * Proves centralization: one routing table drives all department→account paths.
 */

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_SEED_SPECS,
  DEPARTMENT_ACCOUNT_DEFAULTS,
  EMAIL_DEPARTMENTS,
  resolveAccountKey,
} from "../../../src/core/accounts.js";
import {
  defaultCredentialRefs,
  resolveGoogleCredentials,
  resolveLinkedInCredentials,
} from "../../../src/infra/credential-resolver.js";

describe("account registry chain (centralized routing)", () => {
  it("jobhunt google resolves to personal gws profile path", () => {
    const key = resolveAccountKey("google", { department: "jobhunt" });
    expect(key).toBe("personal");

    const refs = defaultCredentialRefs("google", key, "gws");
    const creds = resolveGoogleCredentials(refs);
    expect(creds.gws_profile_dir).toContain("/accounts/personal/gws");
  });

  it("sales google resolves to turicks gws profile path", () => {
    const key = resolveAccountKey("google", { department: "sales" });
    expect(key).toBe("turicks");

    const refs = defaultCredentialRefs("google", key, "gws");
    const creds = resolveGoogleCredentials(refs);
    expect(creds.gws_profile_dir).toContain("/accounts/turicks/gws");
  });

  it("jobhunt linkedin uses personal env var names (not turicks legacy)", () => {
    const key = resolveAccountKey("linkedin", { department: "jobhunt" });
    expect(key).toBe("personal");

    const refs = defaultCredentialRefs("linkedin", key, "direct");
    expect(refs.access_token_env).toBe("LINKEDIN_ACCESS_TOKEN_PERSONAL");
    expect(refs.author_urn_env).toBe("LINKEDIN_AUTHOR_URN_PERSONAL");

    const creds = resolveLinkedInCredentials(refs);
    // undefined in test env — proves lookup path, not hardcoded global
    expect(creds.access_token).toBeUndefined();
  });

  it("turicks linkedin keeps legacy env names for backward compat", () => {
    const refs = defaultCredentialRefs("linkedin", "turicks", "direct");
    expect(refs.access_token_env).toBe("LINKEDIN_ACCESS_TOKEN");
    expect(refs.author_urn_env).toBe("LINKEDIN_AUTHOR_URN");
  });

  it("explicit account_key overrides department routing", () => {
    expect(
      resolveAccountKey("google", { department: "sales", account_key: "personal" }),
    ).toBe("personal");
  });

  it("seed specs are single source — covers turicks + personal + naggar", () => {
    const keys = ACCOUNT_SEED_SPECS.map((s) => s.account_key);
    expect(keys).toContain("turicks");
    expect(keys).toContain("personal");
    expect(keys).toContain("naggar");
    expect(ACCOUNT_SEED_SPECS.find((s) => s.account_key === "turicks")?.platforms.length).toBeGreaterThan(3);
  });

  it("email departments each have google routing in DEPARTMENT_ACCOUNT_DEFAULTS", () => {
    for (const dept of EMAIL_DEPARTMENTS) {
      expect(DEPARTMENT_ACCOUNT_DEFAULTS[dept]?.google).toBeDefined();
    }
    expect(DEPARTMENT_ACCOUNT_DEFAULTS["jobhunt"]?.google).toBe("personal");
    expect(DEPARTMENT_ACCOUNT_DEFAULTS["sales"]?.google).toBe("turicks");
  });
});
