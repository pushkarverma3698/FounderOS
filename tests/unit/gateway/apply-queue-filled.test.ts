/**
 * Apply queue: Claude-filled rows (#1326 / #1330). One list of filled tabs on the page, the same count in the digest.
 */
import { describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/db/client.js", () => ({ getPgPool: () => ({ query: async () => ({ rows: [] }) }) }));

const { buildQueue } = await import("../../../src/gateway/apply-queue-api.js");
const { APPLY_QUEUE_SCRIPT } = await import("../../../src/gateway/apply-queue-script.js");
const { buildQueueDigest } = await import("../../../src/jobs/apply-queue-digest.js");

const profile = { id: "p1" } as JobSearchProfile;
const deps = { now: () => Date.UTC(2026, 10, 25), env: {}, senderFor: () => ({}), submit: vi.fn(), photoTo: vi.fn() } as never;
const filled = (n: number, link: string, blanks: string[] = []) => ({ rowId: `r${n}`, company: `Co${n}`, title: "Dev", link, blanks, filledAt: null });

describe("apply queue: Claude-filled rows", () => {
  it("lists filled tabs in order with a numbered position, job, link and blanks left; drops non-http links", async () => {
    const q = await buildQueue(profile, deps, {
      rows: async () => [],
      macBeat: async () => null,
      filled: async () => [filled(1, "https://jobs.example.test/a", ["Salary"]), filled(2, "javascript:alert(1)")],
    });
    expect(q.filled).toEqual([
      { n: 1, id: "r1", company: "Co1", title: "Dev", link: "https://jobs.example.test/a", blanks: ["Salary"] },
      { n: 2, id: "r2", company: "Co2", title: "Dev", link: "", blanks: [] },
    ]);
  });

  it("an older deps object without `filled` gives an empty list", async () => {
    const q = await buildQueue(profile, deps, { rows: async () => [], macBeat: async () => null });
    expect(q.filled).toEqual([]);
  });

  it("the page script shows the approve-in-chat instruction and the headline count", () => {
    expect(APPLY_QUEUE_SCRIPT).toContain("submit 1, 3 and 5");
    expect(APPLY_QUEUE_SCRIPT).toContain("filled tabs wait for your yes");
    expect(() => new Function(APPLY_QUEUE_SCRIPT)).not.toThrow();
  });

  it("the digest says 'F filled tabs wait for your yes', and sends even when only filled tabs wait", () => {
    const link = { url: "https://apply.example.test/apply/queue", inTelegram: true, macOnline: true };
    const row = { apply_lane: "auto", apply_lane_reason: "all filled" } as unknown as JobApplication;
    const ids = (...n: string[]) => new Set(n);
    expect(buildQueueDigest("P", [row], link, 0, ids("a", "b", "c"))!.text).toContain("3 filled tabs wait for your yes");
    expect(buildQueueDigest("P", [row], link, 0, ids("a"))!.text).toContain("1 filled tab waits for your yes");
    expect(buildQueueDigest("P", [], link, 0, ids("a", "b"))).not.toBeNull();
    expect(buildQueueDigest("P", [row], link)!.text).not.toContain("filled tab");
  });

  it("a filled tab is a hand_off row too: counted once, as filled, not again as 'on the site'", () => {
    const link = { url: "https://apply.example.test/apply/queue", inTelegram: true, macOnline: true };
    const row = { id: "r1", apply_lane: "hand_off", apply_lane_reason: "Workday: needs an account" };
    const text = buildQueueDigest("P", [row], link, 0, new Set(["r1"]))!.text;
    expect(text).toContain("1 role waiting");
    expect(text).toContain("1 filled tab waits for your yes");
    expect(text).not.toContain("on the site");
  });
});
