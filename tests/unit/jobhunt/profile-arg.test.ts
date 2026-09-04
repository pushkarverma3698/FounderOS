/**
 * The profile selector on a job command
 * =====================================
 * `/draft 3` addressing the wrong candidate's row 3 is the failure this file
 * exists to prevent, so the cases here are about what happens when the founder
 * types something slightly wrong — not only when he types it right.
 */

import { describe, it, expect } from "vitest";
import {
  resolveProfileArg,
  isProfileArgMiss,
  profileMissMessage,
} from "../../../src/gateway/jobhunt-profile-arg.js";

function ok(raw: string, reserved: readonly string[] = []) {
  const result = resolveProfileArg(raw, reserved);
  if (isProfileArgMiss(result)) throw new Error(`expected a profile, got a miss on ${raw}`);
  return result;
}

describe("resolveProfileArg", () => {
  it("defaults to the founder's own queue when nothing is named", () => {
    const r = ok("");
    expect(r.profile.id).toBe("pushkar-nl-tech");
    expect(r.explicit).toBe(false);
    expect(r.rest).toBe("");
  });

  it("selects by id, by id segment, and by first name", () => {
    for (const alias of ["wife-nl-finance", "wife", "finance"]) {
      expect(ok(alias).profile.id).toBe("wife-nl-finance");
    }
  });

  it("hands the remainder to the caller's own parser", () => {
    const r = ok("wife 3");
    expect(r.profile.id).toBe("wife-nl-finance");
    expect(r.rest).toBe("3");
    expect(r.explicit).toBe(true);
  });

  it("leaves a bare row number alone", () => {
    const r = ok("3");
    expect(r.profile.id).toBe("pushkar-nl-tech");
    expect(r.rest).toBe("3");
  });

  it("lets the caller's own keywords win over a profile lookup", () => {
    // `/csv all` means the log tab. Without the reservation "all" would be an
    // unknown word and the command would be refused instead of answered.
    const r = ok("all", ["all"]);
    expect(r.profile.id).toBe("pushkar-nl-tech");
    expect(r.rest).toBe("all");
  });

  it("REFUSES a typo rather than silently using the default", () => {
    // The whole point. `/draft wfie 3` must not draft Pushkar's row 3 — that is
    // a tailored application about the wrong company on the wrong CV.
    const miss = resolveProfileArg("wfie 3");
    expect(isProfileArgMiss(miss)).toBe(true);
    if (!isProfileArgMiss(miss)) return;
    expect(miss.unknown).toBe("wfie");
    const message = profileMissMessage(miss);
    expect(message).toContain("haven't touched either one");
    expect(message).toContain("wife-nl-finance");
  });

  it("is case-insensitive", () => {
    expect(ok("WIFE").profile.id).toBe("wife-nl-finance");
  });
});
