/** A persistent outage must not turn into one founder DM per 30-minute sweep. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendToChat = vi.fn();
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: (t: string) => sendToChat(t) }));

const { sendLaneOps, resetLaneOpsThrottle, LANE_OPS_REPEAT_MS } = await import("../../../src/tools/jobhunt/lane-ops-notice.js");

describe("sendLaneOps repeat throttle", () => {
  beforeEach(() => {
    sendToChat.mockReset().mockResolvedValue(undefined);
    resetLaneOpsThrottle();
    vi.useRealTimers();
  });

  it("a message without a repeatKey always goes out", async () => {
    await sendLaneOps("alive");
    await sendLaneOps("alive");
    expect(sendToChat).toHaveBeenCalledTimes(2);
  });

  it("the same repeatKey is sent once inside the window, again after it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T10:00:00Z"));
    await sendLaneOps("failed", { repeatKey: "fetched-nothing:wife" });
    await sendLaneOps("failed", { repeatKey: "fetched-nothing:wife" });
    expect(sendToChat).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + LANE_OPS_REPEAT_MS + 1));
    await sendLaneOps("failed", { repeatKey: "fetched-nothing:wife" });
    expect(sendToChat).toHaveBeenCalledTimes(2);
  });

  it("different keys do not suppress each other", async () => {
    await sendLaneOps("a", { repeatKey: "fetched-nothing:wife" });
    await sendLaneOps("b", { repeatKey: "fetched-nothing:pushkar" });
    expect(sendToChat).toHaveBeenCalledTimes(2);
  });

  it("a send that Telegram rejects does not start the window, so the next sweep retries", async () => {
    sendToChat.mockRejectedValueOnce(new Error("429"));
    await expect(sendLaneOps("failed", { repeatKey: "k" })).rejects.toThrow("429");
    await sendLaneOps("failed", { repeatKey: "k" });
    expect(sendToChat).toHaveBeenCalledTimes(2);
  });
});
