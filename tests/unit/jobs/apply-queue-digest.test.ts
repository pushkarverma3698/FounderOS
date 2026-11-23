import { describe, expect, it, vi } from "vitest";
import { countQueue, queueGroupOf } from "../../../src/tools/jobhunt/apply-queue.js";
import type { JobApplication } from "../../../src/db/schema.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToJobsChat: vi.fn(), jobsChatId: () => "1" }));
vi.mock("../../../src/tools/jobhunt/profile-config.js", () => ({ listProfiles: () => [] }));

const { buildQueueDigest } = await import("../../../src/jobs/apply-queue-digest.js");
const { runEveningBatch } = await import("../../../src/jobs/apply-evening-batch.js");

const r = (apply_lane: string | null, apply_lane_reason: string | null) => ({ apply_lane, apply_lane_reason });
const ROWS = [
  r("auto", "5 of 5 fields filled"), r("auto", "5 of 5 fields filled"), r("auto", "auto-sent: confirmed"),
  r("needs_you", "1 required question(s) unanswered: Why us?"),
  r("hand_off", "CAPTCHA or reCAPTCHA widget on the form; a person has to solve it"),
  r("hand_off", "Bot check blocks automation: datadome"),
  r("hand_off", "Workday: needs an account"),
  r("hand_off", "Form not usable: no fields"),
  r(null, null),
];

describe("apply queue groups", () => {
  it("puts each role in one group from its lane and reason", () => {
    expect(ROWS.map(queueGroupOf)).toEqual(["ready", "ready", null, "answer", "mac", "mac", "site", "site", null]);
    expect(countQueue(ROWS)).toEqual({ ready: 2, answer: 1, mac: 2, site: 2 });
  });
});

describe("daily queue digest", () => {
  const link = { url: "https://apply.example.test/apply/queue", inTelegram: true, macOnline: true };

  it("says the four counts in one message with one Mini App button", () => {
    const m = buildQueueDigest("Pushkar", ROWS, link)!;
    expect(m.text).toContain("7 roles waiting");
    expect(m.text).toContain("2 ready to send");
    expect(m.text).toContain("1 needs one answer");
    expect(m.text).toContain("2 need a click on your Mac");
    expect(m.text).toContain("2 need you on the site");
    expect(m.text).not.toContain("Mac offline");
    expect(m.keyboard).toEqual([[{ text: "Open the queue", web_app: { url: link.url } }]]);
  });

  it("adds Mac offline, falls back to a plain link outside a private chat, and sends nothing when nothing waits", () => {
    const off = buildQueueDigest("Pushkar", ROWS, { ...link, macOnline: false, inTelegram: false })!;
    expect(off.text).toContain("2 need a click on your Mac (Mac offline)");
    expect(off.keyboard).toEqual([[{ text: "Open the queue", url: link.url }]]);
    expect(buildQueueDigest("Pushkar", [r("auto", "auto-sent: confirmed"), r(null, null)], link)).toBeNull();
  });

  it("replaces the per-role cards in the evening batch: one message, no row cards", async () => {
    process.env["APPLY_EVENING_BATCH"] = "on";
    const send = vi.fn(async () => {});
    const profile = { id: "p1", candidateName: "Pushkar Verma" } as JobSearchProfile;
    const waiting = vi.fn(async () => [] as JobApplication[]);
    const sent = await runEveningBatch(new Date("2026-11-23T18:00:00Z"), {
      profiles: () => [profile],
      waiting,
      answerUrl: () => null,
      queue: { rows: async () => ROWS as unknown as JobApplication[], link: async () => link },
      send,
      claim: () => true,
      release: () => {},
    });
    delete process.env["APPLY_EVENING_BATCH"];
    expect(sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(waiting).not.toHaveBeenCalled();
  });
});
