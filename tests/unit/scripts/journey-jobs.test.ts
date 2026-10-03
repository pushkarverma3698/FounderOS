import { describe, expect, it } from "vitest";
import { judgeJobsGroup } from "../../../scripts/lib/journey-jobs.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const BOT = 42;
const msg = (fromId: number, hoursAgo: number, text = "jobs") => ({ fromId, date: (NOW - hoursAgo * 3_600_000) / 1000, text });

describe("judgeJobsGroup (golden journey C)", () => {
  it("passes when the bot posted inside the window", () => {
    const r = judgeJobsGroup([msg(7, 1), msg(BOT, 20, "3 new jobs")], BOT, NOW, 26);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("20.0h ago");
  });
  it("fails when only humans posted inside the window", () => {
    const r = judgeJobsGroup([msg(7, 1), msg(BOT, 30)], BOT, NOW, 26);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("30.0h ago");
  });
  it("fails loudly when the bot never posted", () => {
    const r = judgeJobsGroup([msg(7, 1)], BOT, NOW, 26);
    expect(r).toEqual({ ok: false, detail: "no bot message in the last 1 messages" });
  });
});
