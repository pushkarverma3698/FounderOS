/**
 * The founder's biography must not reach a letter drafted for someone else's profile.
 */
import { describe, expect, it } from "vitest";
import { founderContextFor } from "../../../src/gateway/cover-letter-delivery.js";
import { DEFAULT_PROFILE_ID } from "../../../src/tools/jobhunt/profile-config.js";

describe("founderContextFor", () => {
  it("gives the founder's own profile his context", () => {
    expect(founderContextFor(DEFAULT_PROFILE_ID)).toContain("guesthouse");
  });

  it("states the partner permit the founder confirmed on 2026-10-18, never a sponsored permit", () => {
    const ctx = founderContextFor(DEFAULT_PROFILE_ID)!;
    expect(ctx).toContain("partner permit");
    expect(ctx).not.toMatch(/highly skilled|sponsor|IND /i);
  });

  it("gives every other profile none, so her letter never carries his story", () => {
    expect(founderContextFor("wife-nl-finance")).toBeUndefined();
    expect(founderContextFor("anyone-else")).toBeUndefined();
  });
});
