/**
 * Unit test — a tailoring failure must be able to say why.
 *
 * MEASURED IN PRODUCTION, 2026-08-24: 16 rows carried
 * `tailor_status = 'failed'`, and 14 of them had `notes` reading "Confirmed
 * still open: HTTP 200" or "Could not confirm still open (Indeed job key …)".
 * Both are true statements about LIVENESS. Neither says anything about why a CV
 * was never built.
 *
 * The cause was two writers on one column: `recordTailoringResult` wrote the
 * reason to `notes`, and `recordLiveness` overwrites `notes` on every brief
 * render — which happens many times a day, against a tailoring attempt that
 * happens when the founder types `/draft`. The reasons that survived did so by
 * luck of ordering, and they were the two worth having (a Gemini 5xx and a
 * missing Chromium).
 *
 * So the property pinned here is that the two writers touch DIFFERENT columns,
 * asserted against the update payload rather than against a live database —
 * the unit suite runs on tests/helpers/mock-db and must stay $0.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const updates: Array<Record<string, unknown>> = [];

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        updates.push(payload);
        return {
          where: () => ({ returning: async () => [{ id: "row-1", ...payload }] }),
        };
      },
    }),
  }),
}));

const { recordTailoringResult, recordLiveness } = await import("../../../src/db/job-queries.js");

beforeEach(() => {
  updates.length = 0;
});

describe("recordTailoringResult", () => {
  it("writes the failure reason to tailor_note, never to notes", () => {
    return recordTailoringResult("row-1", {
      tailorStatus: "failed",
      notes: "PDF render failed: browserType.launch: Executable doesn't exist",
    }).then(() => {
      expect(updates).toHaveLength(1);
      expect(updates[0]).toHaveProperty(
        "tailor_note",
        "PDF render failed: browserType.launch: Executable doesn't exist",
      );
      expect(updates[0]).not.toHaveProperty("notes");
    });
  });

  it("omits tailor_note entirely when no reason was given", async () => {
    // `tailorStatus: 'tailoring'` is a progress marker with nothing to explain.
    // Writing an empty string would erase the reason a PREVIOUS attempt left.
    await recordTailoringResult("row-1", { tailorStatus: "tailoring" });
    expect(updates[0]).not.toHaveProperty("tailor_note");
  });
});

describe("recordLiveness", () => {
  it("still writes its own reason to notes, so the two never collide", async () => {
    await recordLiveness("row-1", "live", { reason: "Confirmed still open: HTTP 200" });
    expect(updates[0]).toHaveProperty("notes", "Confirmed still open: HTTP 200");
    expect(updates[0]).not.toHaveProperty("tailor_note");
  });
});
