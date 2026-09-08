/**
 * The apply-queue freshness window belongs to the CANDIDATE, not to the process
 * =============================================================================
 * `APPLY_QUEUE_MAX_AGE_HOURS` was one global constant for both candidates, and
 * the two lanes have opposite problems:
 *
 *   Pushkar   149 roles published per day  → 24h is right; a wider window buries
 *                                            today's finds under last week's
 *   Tashi       9 roles published per day  → 24h means her brief can never show
 *                                            more than about nine rows, however
 *                                            well everything upstream works
 *
 * Measured on prod 2026-09-08. The 24h decision was taken on 2026-09-07 against
 * Pushkar's numbers (442 standing rows vs 35 fresh) and is still right for him —
 * it was simply applied to a lane it had never been measured against.
 */

import { describe, it, expect } from "vitest";
import { getProfile } from "../../../src/tools/jobhunt/profile-config.js";
import { APPLY_QUEUE_MAX_AGE_HOURS, queueWindowFor } from "../../../src/db/job-queries.js";

describe("each candidate carries their own apply-queue window", () => {
  it("leaves the founder on the measured 24-hour window", () => {
    expect(queueWindowFor(getProfile("pushkar-nl-tech"))).toBe(24);
  });

  it("gives the low-supply lane a wider one", () => {
    const wife = queueWindowFor(getProfile("wife-nl-finance"));
    expect(wife).toBeGreaterThan(24);
    expect(wife).toBe(14 * 24);
  });

  it("falls back to the global default when a profile declares none", () => {
    // The default is unchanged, so a profile added tomorrow behaves exactly as
    // every profile did before this field existed.
    const bare = { ...getProfile("pushkar-nl-tech"), applyQueueMaxAgeHours: undefined };
    expect(queueWindowFor(bare)).toBe(APPLY_QUEUE_MAX_AGE_HOURS);
  });

  it("falls back to the global default when no profile is supplied at all", () => {
    expect(queueWindowFor()).toBe(APPLY_QUEUE_MAX_AGE_HOURS);
  });
});
