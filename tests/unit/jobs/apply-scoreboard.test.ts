import { describe, expect, it } from "vitest";
import { countScoreboard, dayWindow, formatScoreboard, isEmptyScoreboard, type ScoreboardInput } from "../../../src/tools/jobhunt/apply-scoreboard.js";

const t = (iso: string) => new Date(iso);
const input: ScoreboardInput = {
  caught: [
    { created_at: t("2026-11-15T08:00:00Z"), apply_lane: "auto", apply_lane_at: t("2026-11-15T09:00:00Z") },
    { created_at: t("2026-11-15T08:00:00Z"), apply_lane: "needs_you", apply_lane_at: t("2026-11-15T11:00:00Z") },
    { created_at: t("2026-11-15T08:00:00Z"), apply_lane: null, apply_lane_at: null },
    // hand_off is routed from the URL alone: no form was filled, so it must not count as filled.
    { created_at: t("2026-11-15T08:00:00Z"), apply_lane: "hand_off", apply_lane_at: t("2026-11-15T13:00:00Z") },
  ],
  waitingLanes: ["needs_you", "needs_you", "hand_off", null],
  attempts: 3,
  submitted: [{ via: "auto" }, { via: "auto" }, { via: "telegram" }, { via: "miniapp" }, { via: "by-hand" }],
  results: [
    { result: "confirmed", detail: "" },
    { result: "failed", detail: "captcha" },
    { result: "failed", detail: "captcha" },
    { result: "unconfirmed", detail: "no proof page" },
  ],
};

describe("countScoreboard", () => {
  const s = countScoreboard(input);
  it("counts the funnel", () => {
    expect(s).toMatchObject({ caught: 4, routedWithin2h: 1, filled: 2, confirmed: 5, clicks: 2 });
  });
  it("splits sent by sender", () => {
    expect(s.sent).toBe(6);
    expect(s.sentBy).toEqual({ vps: 3, afterClick: 2, byHand: 1 });
  });
  it("groups failures by reason with counts, biggest first, confirmed excluded", () => {
    expect(s.failed).toEqual([{ reason: "failed: captcha", count: 2 }, { reason: "unconfirmed: no proof page", count: 1 }]);
  });
  it("counts waiting by lane", () => {
    expect(s.waiting).toEqual({ needsYou: 2, handOff: 1 });
  });
  it("is empty only when nothing happened", () => {
    expect(isEmptyScoreboard(countScoreboard({ caught: [], waitingLanes: [], attempts: 0, submitted: [], results: [] }))).toBe(true);
    expect(isEmptyScoreboard(s)).toBe(false);
  });
});

describe("formatScoreboard", () => {
  const s = countScoreboard(input);
  it("shows the target, every count and each failure reason", () => {
    const text = formatScoreboard("Pushkar", s).join("\n");
    expect(text).toContain("target 35–40 sent/day");
    expect(text).toContain("Caught 4 → routed within 2h 1 → filled 2 → sent 6 → confirmed 5");
    expect(text).toContain("VPS 3, after your click 2, by hand 1");
    expect(text).toContain("2 × failed: captcha");
    expect(text).toContain("Waiting: needs you 2, hand-off 1");
  });
  it("splits rather than drops a row when too long", () => {
    const many = { ...s, failed: Array.from({ length: 60 }, (_, n) => ({ reason: `reason number ${n}`, count: 1 })) };
    const parts = formatScoreboard("", many, 300);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join("\n")).toContain("reason number 59");
  });
});

describe("dayWindow", () => {
  it("uses the Amsterdam day (UTC+1 in November)", () => {
    const w = dayWindow(t("2026-11-15T23:30:00Z"), "Europe/Amsterdam");
    expect(w.start.toISOString()).toBe("2026-11-15T23:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-11-16T23:00:00.000Z");
  });
});
