import { describe, expect, it, vi, beforeEach } from "vitest";
import { defaultCredentialRefs } from "../../../src/infra/credential-resolver.js";
import { clearAccountRegistryCache, resolveAccountContext } from "../../../src/infra/account-registry.js";

vi.mock("../../../src/db/account-queries.js", () => ({
  getIntegrationAccount: vi.fn().mockResolvedValue(null),
  listIntegrationAccounts: vi.fn().mockResolvedValue([]),
  upsertIntegrationAccount: vi.fn(),
}));

describe("account-registry", () => {
  beforeEach(() => {
    clearAccountRegistryCache();
  });

  it("returns convention defaults when no DB row", async () => {
    const ctx = await resolveAccountContext({ platform: "google", department: "jobhunt" });
    expect(ctx.account_key).toBe("personal");
    expect(ctx.auth_backend).toBe("gws");
    expect(ctx.source).toBe("default");
    expect(ctx.credential_refs.gws_profile_dir).toContain("/accounts/personal/gws");
  });

  it("uses explicit account_key over department", async () => {
    const ctx = await resolveAccountContext({
      platform: "linkedin",
      department: "marketing",
      account_key: "personal",
    });
    expect(ctx.account_key).toBe("personal");
  });

  it("defaultCredentialRefs names personal linkedin env vars", () => {
    const refs = defaultCredentialRefs("linkedin", "personal", "direct");
    expect(refs.access_token_env).toBe("LINKEDIN_ACCESS_TOKEN_PERSONAL");
    expect(refs.author_urn_env).toBe("LINKEDIN_AUTHOR_URN_PERSONAL");
  });

  it("defaultCredentialRefs names meta page env vars", () => {
    const refs = defaultCredentialRefs("instagram", "turicks", "meta_graph");
    expect(refs.access_token_env).toBe("INSTAGRAM_ACCESS_TOKEN_TURICKS");
    expect(refs.meta_page_id_env).toBe("META_INSTAGRAM_PAGE_ID_TURICKS");
  });
});
