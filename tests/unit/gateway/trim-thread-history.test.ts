/**
 * Unit tests for trimThreadHistory — the side-effecting wrapper that bounds the
 * persisted conversation history (the permanent fix for the looping bug).
 *
 * Critical safety: it must NEVER call updateState while an approval is pending,
 * because updateState would clobber the paused interrupt. And it must only emit
 * removals when the thread actually exceeds the window.
 */

import { describe, it, expect, vi } from "vitest";
import { HumanMessage, AIMessage, RemoveMessage } from "@langchain/core/messages";
import { trimThreadHistory } from "../../../src/gateway/telegram.js";

const config = { configurable: { thread_id: "turicks:1" }, recursionLimit: 20 };

function manyTurns(n: number) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push(new HumanMessage({ content: `q${i}`, id: `h${i}` }));
    msgs.push(new AIMessage({ content: `a${i}`, id: `a${i}` }));
  }
  return msgs;
}

describe("trimThreadHistory", () => {
  it("does NOT touch state when an approval is pending (would clobber the interrupt)", async () => {
    const office = {
      getState: vi.fn().mockResolvedValue({
        tasks: [{ interrupts: [{ value: { title: "Send email" } }] }],
        values: { messages: manyTurns(40) },
      }),
      updateState: vi.fn(),
    };
    await trimThreadHistory(office, config);
    expect(office.updateState).not.toHaveBeenCalled();
  });

  it("does nothing when the thread is under the window", async () => {
    const office = {
      getState: vi.fn().mockResolvedValue({ tasks: [], values: { messages: manyTurns(3) } }),
      updateState: vi.fn(),
    };
    await trimThreadHistory(office, config);
    expect(office.updateState).not.toHaveBeenCalled();
  });

  it("emits RemoveMessage updates when the thread exceeds the window", async () => {
    const office = {
      getState: vi.fn().mockResolvedValue({ tasks: [], values: { messages: manyTurns(40) } }),
      updateState: vi.fn().mockResolvedValue(undefined),
    };
    await trimThreadHistory(office, config);
    expect(office.updateState).toHaveBeenCalledTimes(1);
    const [cfgArg, update] = office.updateState.mock.calls[0]!;
    expect(cfgArg).toBe(config);
    expect(Array.isArray(update.messages)).toBe(true);
    expect(update.messages.length).toBeGreaterThan(0);
    expect(update.messages.every((m: unknown) => m instanceof RemoveMessage)).toBe(true);
  });
});
