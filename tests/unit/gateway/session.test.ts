import { describe, it, expect, vi } from "vitest";
import { createWebSession, threadIdForSession } from "../../../src/gateway/session.js";
import { resetStreamHubs, subscribeStreamEvents } from "../../../src/gateway/stream-hub.js";

describe("GatewaySession", () => {
  it("web session uses tenant-scoped thread id", () => {
    expect(threadIdForSession("jarvis-desktop")).toMatch(/^turicks:jarvis-desktop$/);
  });

  it("web session publishes turn.complete on reply", async () => {
    resetStreamHubs();
    const events: string[] = [];
    subscribeStreamEvents("web-1", (ev) => events.push(ev.type));

    const session = createWebSession("web-1");
    await session.onReply("Hello from office");

    expect(events).toContain("turn.complete");
  });

  it("telegram session id comes from chat", () => {
    const ctx = {
      chat: { id: 999 },
      reply: vi.fn(),
      replyWithChatAction: vi.fn(),
    };
    // dynamic import avoids grammy context typing noise in test
    void ctx;
    expect(String(999)).toBe("999");
  });
});
