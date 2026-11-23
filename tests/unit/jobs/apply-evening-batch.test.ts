import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToJobsChat: vi.fn() }));
vi.mock("../../../src/tools/jobhunt/profile-config.js", () => ({ listProfiles: () => [] }));

const { runEveningBatch, eveningBatchEnabled, eveningDay, EVENING_CRON, EVENING_TIME_ZONE } = await import("../../../src/jobs/apply-evening-batch.js");

const profile = (id: string, name: string): JobSearchProfile => ({ id, candidateName: name }) as JobSearchProfile;
const row = (n: number, profileId: string, lane: string): JobApplication =>
  ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, profile_id: profileId, company: `Co${n}`, title: `T${n}`, url: "https://j.example/x", apply_lane: lane, apply_lane_reason: "why" }) as JobApplication;

const NOW = new Date("2026-11-15T18:00:00Z");

function deps(rowsByProfile: Record<string, JobApplication[]>, claimed = new Set<string>()) {
  const send = vi.fn(async () => {});
  return {
    send,
    claimed,
    d: {
      profiles: () => [profile("p1", "Pushkar Verma"), profile("p2", "Tashi Dolma")],
      waiting: async (id: string) => rowsByProfile[id] ?? [],
      answerUrl: () => null,
      send,
      claim: (id: string) => (claimed.has(id) ? false : (claimed.add(id), true)),
      release: (id: string) => void claimed.delete(id),
    },
  };
}

beforeEach(() => { process.env["APPLY_EVENING_BATCH"] = "on"; });
afterEach(() => { delete process.env["APPLY_EVENING_BATCH"]; });

describe("kill switch", () => {
  it("is off unless exactly on", () => {
    expect(eveningBatchEnabled({})).toBe(false);
    expect(eveningBatchEnabled({ APPLY_EVENING_BATCH: "off" })).toBe(false);
    expect(eveningBatchEnabled({ APPLY_EVENING_BATCH: " ON " })).toBe(true);
  });
  it("sends nothing and reads nothing when off", async () => {
    delete process.env["APPLY_EVENING_BATCH"];
    const waiting = vi.fn();
    const { d, send } = deps({ p1: [row(1, "p1", "needs_you")] });
    expect(await runEveningBatch(NOW, { ...d, waiting })).toBe(0);
    expect(waiting).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("runEveningBatch", () => {
  it("sends one batch per profile that has waiting rows, and nothing for an empty profile", async () => {
    const { d, send } = deps({ p1: [row(1, "p1", "needs_you"), row(2, "p1", "hand_off")] });
    expect(await runEveningBatch(NOW, d)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    const first = send.mock.calls[0] as unknown as [{ text: string }];
    expect(first[0].text).toContain("Pushkar");
    expect(first[0].text).not.toContain("Tashi");
  });

  it("drops unresolved Himalayas/Jobicy hand-off rows and says so in ONE line", async () => {
    const hi = { ...row(3, "p1", "hand_off"), url: "https://himalayas.app/companies/a/jobs/b?utm_source=api" };
    const jo = { ...row(4, "p1", "hand_off"), url: "https://jobicy.com/jobs/1-x" };
    const { d, send } = deps({ p1: [row(1, "p1", "needs_you"), hi, jo] });
    await runEveningBatch(NOW, d);
    const text = (send.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(text).toContain("1 role waiting");
    expect(text).not.toContain("Co3");
    expect(text).not.toContain("Co4");
    expect(text.match(/no employer link/g)?.length).toBe(1);
    expect(text).toContain("2 Himalayas/Jobicy rows had no employer link");
  });

  it("does not send twice on the same day (restart or double fire)", async () => {
    const { d, send } = deps({ p1: [row(1, "p1", "needs_you")] });
    await runEveningBatch(NOW, d);
    expect(await runEveningBatch(NOW, d)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the send fails so the next tick can retry, and the other profile still goes", async () => {
    const { d, send, claimed } = deps({ p1: [row(1, "p1", "needs_you")], p2: [row(2, "p2", "hand_off")] });
    send.mockRejectedValueOnce(new Error("telegram down"));
    expect(await runEveningBatch(NOW, d)).toBe(1);
    expect(claimed.has("p1")).toBe(false);
    expect(claimed.has("p2")).toBe(true);
  });

  it("does not claim a day for a profile with nothing waiting", async () => {
    const { d, claimed } = deps({});
    await runEveningBatch(NOW, d);
    expect(claimed.size).toBe(0);
  });
});

describe("schedule", () => {
  it("is 19:00 in Amsterdam", () => {
    expect(EVENING_CRON).toBe("0 19 * * *");
    expect(EVENING_TIME_ZONE).toBe("Europe/Amsterdam");
  });
  it("keys the day by the Amsterdam date, not UTC", () => {
    expect(eveningDay(new Date("2026-11-15T23:30:00Z"))).toBe("2026-11-16");
  });
});

describe("scoreboard in the evening batch", () => {
  it("sends the scoreboard first, even when nothing waits", async () => {
    const { d, send } = deps({});
    const scoreboard = vi.fn(async () => ["<b>Scoreboard</b>"]);
    expect(await runEveningBatch(NOW, { ...d, scoreboard })).toBe(2);
    expect(send).toHaveBeenCalledWith({ text: "<b>Scoreboard</b>", keyboard: [] });
  });
  it("puts it before the waiting list", async () => {
    const { d, send } = deps({ p1: [row(1, "p1", "needs_you")] });
    await runEveningBatch(NOW, { ...d, scoreboard: async (id) => (id === "p1" ? ["<b>SB</b>"] : []) });
    expect((send.mock.calls[0] as unknown as [{ text: string }])[0].text).toBe("<b>SB</b>");
    expect(send.mock.calls.length).toBeGreaterThan(1);
  });
});
