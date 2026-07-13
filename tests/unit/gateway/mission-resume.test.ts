/**
 * Boot-time mission resume — tested with a FAKE kernel (repo rule #19.3),
 * same recipe as scheduled-task-run.test.ts. Verifies the crash signature is
 * detected narrowly (pure predicate), a crashed mission continues from its
 * checkpoint via a null-input stream, HITL pauses raise a card, gates skip
 * quietly, and a resume failure folds into thread history and reports loud.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const DONE_STATE = { reply: "Resumed and finished.", mission: { status: "done", plan: null, cursor: 0, goal: "" } };

async function* singleYield(state: unknown) {
  yield state;
}

/** A checkpoint carrying the exact crash signature (mid-run, no interrupt, no fold). */
function crashedSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    next: ["agent"],
    createdAt: new Date().toISOString(),
    tasks: [],
    values: {
      mission: { status: "executing", goal: "Draft the investor update" },
      reply: "",
      failure: null,
    },
    ...overrides,
  };
}

const fakeKernel = {
  stream: vi.fn((..._args: unknown[]) => singleYield(DONE_STATE)),
  getState: vi.fn(async (): Promise<unknown> => crashedSnapshot()),
  updateState: vi.fn(async (..._args: unknown[]) => ({})),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => fakeKernel),
}));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, getTodayCostUsd: vi.fn(async () => 0) };
});

const mockReadHalt = vi.fn(async (): Promise<unknown> => null);
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: (...a: unknown[]) => mockReadHalt(...(a as [])),
  formatHaltNotice: vi.fn(() => "halted"),
}));

interface Sent {
  chatId: string | number;
  text: string;
  opts?: { reply_markup?: unknown };
}
const sent: Sent[] = [];
const mockSendMessage = vi.fn(async (chatId: string | number, text: string, opts?: Sent["opts"]) => {
  sent.push({ chatId, text, ...(opts !== undefined ? { opts } : {}) });
  return { message_id: 1 };
});
vi.mock("../../../src/gateway/telegram.js", () => ({
  getBot: () => ({ api: { sendMessage: mockSendMessage } }),
}));

const { resumeDecision, resumeInterruptedMission, MISSION_RESUME_MAX_AGE_MS } = await import(
  "../../../src/gateway/mission-resume.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  fakeKernel.stream.mockImplementation(() => singleYield(DONE_STATE));
  fakeKernel.getState.mockImplementation(async () => crashedSnapshot());
  mockReadHalt.mockResolvedValue(null);
});

describe("resumeDecision (pure crash-signature predicate)", () => {
  const NOW = Date.now();

  it("accepts the exact crash signature", () => {
    expect(resumeDecision(crashedSnapshot(), NOW)).toEqual({ resume: true });
  });

  it.each([
    ["no checkpoint", undefined, "no checkpoint"],
    ["nothing in flight", crashedSnapshot({ next: [] }), "no pending graph nodes"],
    ["HITL pause", crashedSnapshot({ tasks: [{ interrupts: [{ value: {} }] }] }), "HITL interrupt"],
    [
      "handled failure was folded",
      crashedSnapshot({
        values: { mission: { status: "executing", goal: "g" }, reply: "The turn stopped…", failure: { stage: "timeout" } },
      }),
      "failure already folded",
    ],
    [
      "turn completed",
      crashedSnapshot({ values: { mission: { status: "executing", goal: "g" }, reply: "done", failure: null } }),
      "already produced a reply",
    ],
    [
      "mission not mid-run",
      crashedSnapshot({ values: { mission: { status: "planning", goal: "g" }, reply: "", failure: null } }),
      "not mid-run",
    ],
    ["timestamp missing", crashedSnapshot({ createdAt: undefined }), "no timestamp"],
    [
      "checkpoint stale",
      crashedSnapshot({ createdAt: new Date(NOW - MISSION_RESUME_MAX_AGE_MS - 1000).toISOString() }),
      "older than the resume window",
    ],
  ])("skips when %s", (_label, snapshot, reasonFragment) => {
    const d = resumeDecision(snapshot as never, NOW);
    expect(d.resume).toBe(false);
    if (!d.resume) expect(d.reason).toContain(reasonFragment);
  });

  it("accepts a mission caught between the last step and the synthesizer", () => {
    const snap = crashedSnapshot({
      next: ["synthesize"],
      values: { mission: { status: "synthesizing", goal: "g" }, reply: "", failure: null },
    });
    expect(resumeDecision(snap, NOW)).toEqual({ resume: true });
  });
});

describe("resumeInterruptedMission", () => {
  it("continues a crashed mission from its checkpoint (null input) and delivers the reply", async () => {
    // First getState: the boot probe (crashed). Second: the post-run approval check (clean).
    fakeKernel.getState
      .mockResolvedValueOnce(crashedSnapshot())
      .mockResolvedValueOnce({ tasks: [] });

    const resumed = await resumeInterruptedMission("6775330211");

    expect(resumed).toBe(true);
    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
    const [input, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      unknown,
      { configurable: { thread_id: string } },
    ];
    expect(input).toBeNull(); // resume = continue the checkpoint, never re-inject input
    expect(config.configurable.thread_id).toBe("turicks:6775330211");

    expect(sent).toHaveLength(2); // 🔄 notice + final reply
    expect(sent[0]!.text).toContain("Resuming the task interrupted by the restart");
    expect(sent[0]!.text).toContain("Draft the investor update");
    expect(sent.at(-1)!.text).toContain("Resumed and finished.");
  });

  it("does nothing when the checkpoint carries no crash signature", async () => {
    fakeKernel.getState.mockResolvedValue({ next: [], tasks: [], values: {} });

    const resumed = await resumeInterruptedMission("6775330211");

    expect(resumed).toBe(false);
    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0); // silent skip — no noise on a clean boot
  });

  it("halt gate skips the resume without touching the kernel", async () => {
    mockReadHalt.mockResolvedValue({ reason: "founder /halt" });

    const resumed = await resumeInterruptedMission("6775330211");

    expect(resumed).toBe(false);
    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(fakeKernel.getState).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("re-raises the approval card when the resumed run pauses on a gated step", async () => {
    fakeKernel.getState.mockResolvedValueOnce(crashedSnapshot()).mockResolvedValueOnce({
      tasks: [
        {
          interrupts: [
            {
              value: {
                kind: "approval",
                action: "email_send",
                title: "Send this email?",
                summary: "s",
                preview: "p",
                args: {},
              },
            },
          ],
        },
      ],
    });

    const resumed = await resumeInterruptedMission("6775330211");

    expect(resumed).toBe(true);
    expect(sent.at(-1)!.text).toContain("Send this email?");
    expect(sent.at(-1)!.opts?.reply_markup).toBeDefined();
  });

  it("resume failure folds into thread history and reports loud", async () => {
    const deadTurn = { id: "t-dead", chat_id: "6775330211", received_at: "", raw_input: "x" };
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("429 Provider returned error");
    });
    fakeKernel.getState.mockImplementation(async () => crashedSnapshot({ values: { ...crashedSnapshot().values, turn: deadTurn } }));

    const resumed = await resumeInterruptedMission("6775330211");

    expect(resumed).toBe(true); // attempted and reported — not a silent skip
    expect(fakeKernel.updateState).toHaveBeenCalledTimes(1); // failed-turn history fold
    expect(sent.at(-1)!.text).toContain("Resume failed");
    expect(sent.at(-1)!.text).toContain("429");
  });
});
