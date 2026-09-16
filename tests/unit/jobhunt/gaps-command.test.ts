/**
 * Unit tests — /gaps track resolution.
 *
 * `cv_gaps` has existed since 2026-08 and produces exactly the ranked list the
 * founder needs to decide which keywords to add to his base CV. It was reachable
 * only by asking the model in plain English, so in practice it was never run:
 * every Telegram command has a `/wife_` twin and this had neither half.
 *
 * THE TRACK IS THE TRAP. `DEFAULT_GAP_TRACK` is the string "ai", which is one of
 * Pushkar's four tracks and none of Tashi's — hers are fpa, compliance-kyc,
 * auditor and accountant. Passing "ai" for her profile silently reports the
 * TECH market's gaps against her finance CV: every term looks missing, and the
 * report is confidently wrong in both directions at once (the exact failure
 * `buildGapReport`'s own comment warns about).
 */

import { describe, it, expect } from "vitest";
import { gapsTrackFor } from "../../../src/gateway/jobhunt-view.js";
import { PUSHKAR_PROFILE } from "../../../src/tools/jobhunt/profile-config.js";
import { WIFE_FINANCE_PROFILE } from "../../../src/tools/jobhunt/profiles/wife-nl-finance.js";

describe("gapsTrackFor", () => {
  it("defaults to the PROFILE's own first track, never a global constant", () => {
    expect(gapsTrackFor(PUSHKAR_PROFILE, "")).toBe("ai");
    expect(gapsTrackFor(WIFE_FINANCE_PROFILE, "")).toBe("fpa");
  });

  it("accepts a track the profile actually defines", () => {
    expect(gapsTrackFor(PUSHKAR_PROFILE, "backend")).toBe("backend");
    expect(gapsTrackFor(WIFE_FINANCE_PROFILE, "auditor")).toBe("auditor");
  });

  it("is case- and padding-insensitive", () => {
    expect(gapsTrackFor(PUSHKAR_PROFILE, "  Frontend ")).toBe("frontend");
  });

  it("falls back to the profile default for a track it does not define", () => {
    // "ai" is a real track — for the OTHER candidate. Reporting the tech market
    // against a finance CV is the silent-wrong-answer case this guards.
    expect(gapsTrackFor(WIFE_FINANCE_PROFILE, "ai")).toBe("fpa");
    expect(gapsTrackFor(PUSHKAR_PROFILE, "auditor")).toBe("ai");
    expect(gapsTrackFor(PUSHKAR_PROFILE, "nonsense")).toBe("ai");
  });
});
