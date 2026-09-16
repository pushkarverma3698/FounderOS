/**
 * jobhunt-backfill-gates.ts must resolve --profile explicitly, never fall
 * through to screenPosting/listRecentApplications's own default.
 * =================================================================
 * Without this, the script re-screens EVERY stored row — both candidates'
 * mixed together — under whichever profile getProfile() defaults to
 * (pushkar-nl-tech). Run against wife-nl-finance's stale rows, that silently
 * rewrites them with the wrong candidate's salary floor, permit bases and
 * track — exactly the failure job-queries.ts's own header comment names.
 */

import { describe, it, expect } from "vitest";
import { resolveProfileArg } from "../../../scripts/jobhunt-backfill-gates.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";

describe("resolveProfileArg", () => {
  it("resolves --profile=<id> to that profile's id and full object", () => {
    const resolved = resolveProfileArg(["node", "jobhunt-backfill-gates.ts", "--profile=wife-nl-finance"]);
    expect(resolved.profileId).toBe("wife-nl-finance");
    expect(resolved.profile).toEqual(WIFE_FINANCE_PROFILE);
  });

  it("returns nothing when --profile is omitted — caller must not guess a default", () => {
    const resolved = resolveProfileArg(["node", "jobhunt-backfill-gates.ts", "--dry"]);
    expect(resolved.profileId).toBeUndefined();
    expect(resolved.profile).toBeUndefined();
  });

  it("throws on an unregistered profile id rather than silently screening under the default", () => {
    expect(() => resolveProfileArg(["node", "jobhunt-backfill-gates.ts", "--profile=no-such-profile"])).toThrow(
      /not found/i,
    );
  });
});
