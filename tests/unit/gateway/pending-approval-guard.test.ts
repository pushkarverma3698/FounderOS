/**
 * Unit tests for the pending-approval guard (the headline reliability fix).
 *
 * Root cause of the unreliability: a new free-text message was invoked on a
 * thread that still had an unresolved interrupt() — the graph re-served its
 * parked state, so the founder got a stale reply + phantom tool error every
 * turn. The guard detects a pending approval BEFORE a fresh invoke and drains
 * it with Command({ resume: "rejected" }) — fail-safe, because the HITL wrappers
 * only run side effects on "approved", never on rejection.
 *
 * Fake office: { getState, invoke }. No network, no LangGraph runtime.
 */

import { describe, it, expect, vi } from "vitest";
import { Command } from "@langchain/langgraph";
import { resolvePendingApproval } from "../../../src/gateway/telegram.js";

vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: vi.fn(async () => null),
  resolveInterrupt: vi.fn(async () => true),
}));

const config = { configurable: { thread_id: "turicks:123" } };

function officeWithInterrupt(approval: unknown) {
  return {
    getState: vi.fn().mockResolvedValue({
      tasks: [{ interrupts: [{ value: approval }] }],
      values: { messages: [] },
    }),
    invoke: vi.fn().mockResolvedValue({ messages: [] }),
  };
}

function officeNoInterrupt() {
  return {
    getState: vi.fn().mockResolvedValue({ tasks: [], values: { messages: [] } }),
    invoke: vi.fn().mockResolvedValue({ messages: [] }),
  };
}

describe("resolvePendingApproval", () => {
  it("returns null and does NOT invoke when there is no pending interrupt", async () => {
    const office = officeNoInterrupt();
    const out = await resolvePendingApproval(office, config);
    expect(out).toBeNull();
    expect(office.invoke).not.toHaveBeenCalled();
  });

  it("returns the pending approval and drains it with Command({resume:'rejected'})", async () => {
    const approval = { title: "Send email", summary: "to alex@acme.com" };
    const office = officeWithInterrupt(approval);

    const out = await resolvePendingApproval(office, config);

    expect(out).toEqual(approval);
    expect(office.invoke).toHaveBeenCalledTimes(1);
    const [cmdArg, cfgArg] = office.invoke.mock.calls[0]!;
    expect(cmdArg).toBeInstanceOf(Command);
    expect((cmdArg as Command).resume).toBe("rejected");
    expect(cfgArg).toEqual(config); // same thread_id — resume must target the parked thread
  });
});
