/**
 * brain-sync must not re-embed a doc that declares itself Archived/Superseded: search skips those rows, and an embed
 * timeout used to leave the doc's old chunks ACTIVE (2026-10-27: 44 kernel-era chunks stayed searchable).
 */
import { describe, it, expect } from "vitest";
import { chunkPlan } from "../../../scripts/sync-turicks-brain.js";

describe("chunkPlan", () => {
  it("restatuses an archived doc in place instead of embedding it", () => {
    expect(chunkPlan("ARCHIVED", 0, 23)).toBe("restatus");
    expect(chunkPlan("SUPERSEDED", 5, 23)).toBe("restatus");
  });
  it("embeds an active doc whose chunks are out of date", () => {
    expect(chunkPlan("ACTIVE", 3, 23)).toBe("embed");
  });
  it("does nothing for an active doc that is current or empty", () => {
    expect(chunkPlan("ACTIVE", 23, 23)).toBe("current");
    expect(chunkPlan("ARCHIVED", 0, 0)).toBe("current");
  });
});
