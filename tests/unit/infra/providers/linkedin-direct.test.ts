/**
 * LinkedIn direct API — version pin floor.
 * LIVE FAILURE 2026-07-12 (turns 68eae59d, 64ba4004): prod .env carried a
 * stale LINKEDIN_API_VERSION=202405 from an old PROD_DOTENV snapshot, which
 * silently overrode the shipped default (202606) and 426'd every LinkedIn
 * call — get_my_posts degraded to bare audit-log URNs, making "summarise my
 * posts" impossible. The env pin may only move the version FORWARD; a stale
 * pin below the code default is ignored.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const readEnvValue = vi.fn((_key: string): string | undefined => undefined);
vi.mock("../../../../src/infra/credential-resolver.js", () => ({
  readEnvValue: (key: string) => readEnvValue(key),
}));

const { getLinkedInApiVersion, LINKEDIN_DEFAULT_API_VERSION } = await import(
  "../../../../src/infra/providers/linkedin-direct.js"
);

beforeEach(() => {
  readEnvValue.mockReturnValue(undefined);
});

describe("getLinkedInApiVersion — stale env pins cannot downgrade", () => {
  it("returns the code default when the env var is unset", () => {
    expect(getLinkedInApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
  });

  it("ignores a stale pin BELOW the code default (the live 202405 clobber)", () => {
    readEnvValue.mockReturnValue("202405");
    expect(getLinkedInApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
  });

  it("honors a deliberate pin AHEAD of the code default", () => {
    readEnvValue.mockReturnValue("202701");
    expect(getLinkedInApiVersion()).toBe("202701");
  });

  it("ignores malformed pins", () => {
    readEnvValue.mockReturnValue("latest");
    expect(getLinkedInApiVersion()).toBe(LINKEDIN_DEFAULT_API_VERSION);
  });
});
