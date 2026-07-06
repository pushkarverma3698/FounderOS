/**
 * P2 — engineering subgraph HITL card surfaces through the real gateway run-loop.
 * Uses a fake office with a nested github_write interrupt; asserts hitl.interrupt
 * seam fires and turn.out does NOT (same contract as flat HITL).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setTraceSink, type TraceEvent } from "../../../src/infra/trace.js";

const getOffice = vi.fn();
const clearThreadCheckpoints = vi.fn(async () => 1);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice };
});

const { runOfficeText } = await import("../../../src/gateway/office-run.js");

let events: TraceEvent[];
const seams = () => events.map((e) => e.seam);

/** Nested engineering interrupt — github_write from devops sub-agent. */
const engineeringApproval = {
  kind: "approval",
  action: "github_write",
  title: "🔧 Create GitHub issue?",
  summary: "pushkarverma3698/FounderOS — chore: P2 verify",
  preview: "Routine dependency update",
  args: { owner: "pushkarverma3698", repo: "FounderOS", action: "create_issue" },
};

function fakeCtx() {
  return {
    chat: { id: 42 },
    from: { id: 42 },
    message: { text: "create github issue" },
    reply: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeOfficeWithNestedInterrupt() {
  let parked = false;
  const invoke = vi.fn(async () => {
    parked = true;
    return { messages: [] };
  });
  const getState = vi.fn(async () => {
    if (parked) {
      return {
        values: { messages: [] },
        next: ["engineering"],
        tasks: [{ interrupts: [{ value: engineeringApproval }] }],
      };
    }
    return { values: { messages: [] }, next: [], tasks: [] };
  });
  return { getState, invoke, updateState: vi.fn(async () => {}) };
}

beforeEach(() => {
  events = [];
  getOffice.mockReset();
  clearThreadCheckpoints.mockClear();
  setTraceSink((e) => events.push(e));
});

afterEach(() => {
  setTraceSink(null);
  vi.clearAllMocks();
});

describe("P2 gateway — nested engineering HITL card", () => {
  it("surfaces github_write interrupt via hitl.interrupt without turn.out", async () => {
    getOffice.mockResolvedValue(makeOfficeWithNestedInterrupt());
    const ctx = fakeCtx();

    await runOfficeText(ctx, engineeringApproval.summary);

    expect(seams()).toContain("hitl.interrupt");
    expect(seams()).not.toContain("turn.out");
    expect(ctx.reply).toHaveBeenCalled();
    // M5: this test's fake env has no DB, so the daily-budget check itself
    // fails open and now sends a visible (separate) degraded-gate notice —
    // check the LAST reply (the actual HITL card), not assume it's the first.
    const calls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
    const replyText = String(calls[calls.length - 1]?.[0] ?? "");
    expect(replyText.toLowerCase()).toMatch(/github|issue|approve|reject/);
  });
});
