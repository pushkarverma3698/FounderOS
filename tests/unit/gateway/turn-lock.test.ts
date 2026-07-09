import { describe, it, expect } from "vitest";
import { withChatTurnLock } from "../../../src/gateway/kernel-run.js";

describe("withChatTurnLock", () => {
  it("runs turns for the same chat sequentially", async () => {
    const order: number[] = [];
    const first = withChatTurnLock("chat-1", async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      order.push(2);
    });
    const second = withChatTurnLock("chat-1", async () => {
      order.push(3);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("does not block different chats", async () => {
    const order: string[] = [];
    await Promise.all([
      withChatTurnLock("a", async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push("a");
      }),
      withChatTurnLock("b", async () => {
        order.push("b");
      }),
    ]);
    expect(order[0]).toBe("b");
    expect(order[1]).toBe("a");
  });
});
