/**
 * Scheduled-task runner — tested with a FAKE kernel (repo rule #19.3), same
 * recipe as kernel-run.test.ts. Verifies a due task fires as a normal kernel
 * turn on the founder's thread, HITL cards go out with a keyboard, gates defer
 * instead of consuming the task, and failures fold into thread history.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const DONE_STATE = { reply: "All done.", mission: { status: "done", plan: null, cursor: 0, goal: "" } };

async function* singleYield(state: unknown) {
  yield state;
}

const fakeKernel = {
  stream: vi.fn((..._args: unknown[]) => singleYield(DONE_STATE)),
  getState: vi.fn(async () => ({ tasks: [] })),
  updateState: vi.fn(async (..._args: unknown[]) => ({})),
};
vi.mock("../../../src/gateway/kernel-boot.js", () => ({
  getKernel: vi.fn(async () => fakeKernel),
}));

const mockMarkDone = vi.fn(async () => {});
const mockMarkFailed = vi.fn(async () => {});
const mockRelease = vi.fn(async () => {});
vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getTodayCostUsd: vi.fn(async () => 0),
    markScheduledTaskDone: mockMarkDone,
    markScheduledTaskFailed: mockMarkFailed,
    releaseScheduledTask: mockRelease,
  };
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

const { runDueScheduledTask, MAX_TASK_ATTEMPTS, TASK_DEFER_MS } = await import(
  "../../../src/gateway/scheduled-task-run.js"
);
import type { ScheduledTask } from "../../../src/db/schema.js";

function claimedTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "st1",
    tenant_id: "turicks",
    prompt: "Summarise my LinkedIn analytics",
    chat_id: "6775330211",
    scheduled_at: new Date(),
    status: "running",
    attempts: 1,
    idempotency_key: "schedtask:abc",
    error: null,
    created_at: new Date(),
    completed_at: null,
    ...overrides,
  } as ScheduledTask;
}

beforeEach(() => {
  vi.clearAllMocks();
  sent.length = 0;
  fakeKernel.stream.mockImplementation(() => singleYield(DONE_STATE));
  fakeKernel.getState.mockResolvedValue({ tasks: [] } as never);
  mockReadHalt.mockResolvedValue(null);
});

describe("runDueScheduledTask", () => {
  it("fires the task as a kernel turn on the founder's thread and marks it done", async () => {
    await runDueScheduledTask(claimedTask());

    expect(fakeKernel.stream).toHaveBeenCalledTimes(1);
    const [input, config] = fakeKernel.stream.mock.calls[0]! as unknown as [
      { turn: { raw_input: string; chat_id: string } },
      { configurable: { thread_id: string } },
    ];
    expect(input.turn.raw_input).toBe("Summarise my LinkedIn analytics");
    expect(config.configurable.thread_id).toBe("turicks:6775330211");

    expect(sent).toHaveLength(2); // ⏰ announce + final reply
    expect(sent[0]!.text).toContain("Scheduled task running");
    expect(sent.at(-1)!.text).toContain("All done.");
    expect(mockMarkDone).toHaveBeenCalledWith("st1");
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("halt gate defers the task (release, no kernel call, no consume)", async () => {
    mockReadHalt.mockResolvedValue({ reason: "founder /halt" });

    await runDueScheduledTask(claimedTask({ attempts: 1 }));

    expect(fakeKernel.stream).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    const [id, nextAt] = mockRelease.mock.calls[0]! as unknown as [string, Date];
    expect(id).toBe("st1");
    expect(nextAt.getTime()).toBeGreaterThan(Date.now() + TASK_DEFER_MS - 5_000);
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it("gives up loud past the attempt cap instead of zombie-deferring forever", async () => {
    mockReadHalt.mockResolvedValue({ reason: "founder /halt" });

    await runDueScheduledTask(claimedTask({ attempts: MAX_TASK_ATTEMPTS }));

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith("st1", expect.stringContaining("gave up"));
    expect(sent.at(-1)!.text).toContain("Scheduled task dropped");
  });

  it("pauses on a pending approval: card with Approve/Reject keyboard goes to the founder", async () => {
    fakeKernel.getState.mockResolvedValue({
      tasks: [
        {
          interrupts: [
            {
              value: {
                kind: "approval",
                action: "linkedin_post",
                title: "Publish this LinkedIn post?",
                summary: "s",
                preview: "p",
                args: {},
              },
            },
          ],
        },
      ],
    } as never);

    await runDueScheduledTask(claimedTask());

    expect(sent.at(-1)!.text).toContain("Publish this LinkedIn post?");
    expect(sent.at(-1)!.opts?.reply_markup).toBeDefined();
    expect(mockMarkDone).toHaveBeenCalledWith("st1"); // the turn ran; the card is the founder's move
  });

  it("kernel failure → marks failed, folds the turn into history, notifies loud", async () => {
    const deadTurn = { id: "t-dead", chat_id: "6775330211", received_at: "", raw_input: "x" };
    fakeKernel.stream.mockImplementation(async function* () {
      throw new Error("429 Provider returned error");
    });
    fakeKernel.getState.mockResolvedValue({ tasks: [], values: { turn: deadTurn } } as never);

    await runDueScheduledTask(claimedTask());

    expect(mockMarkFailed).toHaveBeenCalledWith("st1", expect.stringContaining("429"));
    expect(fakeKernel.updateState).toHaveBeenCalledTimes(1); // failed-turn history fold
    expect(sent.at(-1)!.text).toContain("Scheduled task failed");
    expect(mockMarkDone).not.toHaveBeenCalled();
  });
});
