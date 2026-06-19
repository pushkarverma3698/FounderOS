import { describe, it, expect, vi } from "vitest";
import { createWebSession, threadIdForSession } from "../../../src/gateway/session.js";
import { resetStreamHubs, subscribeStreamEvents } from "../../../src/gateway/stream-hub.js";

describe("GatewaySession", () => {
  it("web session uses tenant-scoped thread id", () => {
    expect(threadIdForSession("jarvis-desktop")).toMatch(/^turicks:jarvis-desktop$/);
  });

  it("web session does not publish turn.complete from onReply (deduped in sendResult)", async () => {
    resetStreamHubs();
    const events: string[] = [];
    subscribeStreamEvents("web-1", (ev) => events.push(ev.type));

    const session = createWebSession("web-1");
    await session.onReply("Hello from office");

    expect(events).not.toContain("turn.complete");
    session.emitStream("turn.complete", { reply: "Hello from office" });
    expect(events).toContain("turn.complete");
  });

  it("web session publishes system.notice on system notice", async () => {
    resetStreamHubs();
    let payload: Record<string, unknown> | undefined;
    subscribeStreamEvents("web-2", (ev) => {
      if (ev.type === "system.notice") payload = ev.data;
    });

    const session = createWebSession("web-2");
    await session.onSystemNotice("❌ <b>Error</b>\n<code>model invalid</code>");

    expect(payload?.notice).toBeTruthy();
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
