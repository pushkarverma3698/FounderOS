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

  it("gives every other profile none, so her letter never carries his story", () => {
    expect(founderContextFor("wife-nl-finance")).toBeUndefined();
    expect(founderContextFor("anyone-else")).toBeUndefined();
  });
});
