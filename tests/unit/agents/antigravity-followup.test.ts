/**
 * Following up on an Antigravity task from Telegram.
 * ==================================================
 * 2026-09-28 18:48: "You dispatch the task if antigravity has yet not picked up
 * the task." The only tool was dispatch_antigravity_task, so the bot tried to
 * open a SECOND issue for the same work; the founder rejected it ("You don't
 * need to open another issue fool you need to dispatch work to antigravity to
 * pickup that task"). requeue_antigravity_task puts the same issue back.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const kick = vi.fn(async (..._a: unknown[]) => ({ status: "started" }));
const audit = vi.fn(async () => ({ written: true }));
const gh = {
  update: vi.fn(async () => ({})),
  removeLabel: vi.fn(async () => ({})),
  addLabels: vi.fn(async () => ({})),
  createComment: vi.fn(async () => ({})),
  listForRepo: vi.fn(async () => ({ data: [{ number: 762 }] })),
};
let currentFacts: Record<string, unknown>;

vi.mock("../../../src/agents/agent-tools/hitl.js", () => ({
  hitlGate: (...a: unknown[]) => mockHitlGate(...a),
  idemKey: (...parts: string[]) => parts.join("|"),
}));
vi.mock("../../../src/tools/dispatch-tick.js", () => ({
  startDispatchJob: (...a: unknown[]) => kick(...a),
  startFailureNote: (n: number, repo: string, reason: string) => `could not start ${repo}#${n}: ${reason}`,
}));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: vi.fn(async () => false),
  writeAuditEntry: (...a: unknown[]) => audit(...(a as [])),
}));
vi.mock("../../../src/tools/dispatch-antigravity.js", () => ({
  resolveDispatchRepo: vi.fn(async () => ({ owner: "pushkarverma3698", repo: "FounderOS" })),
}));
vi.mock("octokit", () => ({
  Octokit: vi.fn(() => ({
    rest: {
      issues: {
        update: gh.update,
        removeLabel: gh.removeLabel,
        addLabels: gh.addLabels,
        createComment: gh.createComment,
        listForRepo: gh.listForRepo,
      },
    },
  })),
}));
vi.mock("../../../src/tools/antigravity-status.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/tools/antigravity-status.js")>()),
  fetchTaskFacts: vi.fn(async () => currentFacts),
}));

process.env["GITHUB_TOKEN"] = "test";
const { requeueAntigravityTask, antigravityTaskStatus } = await import(
  "../../../src/agents/agent-tools/antigravity-followup.js"
);

function factsWith(labels: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "pushkarverma3698/FounderOS",
    issue: {
      number: 762,
      title: "feat: x",
      state: "open",
      labels,
      createdAt: "2026-09-28T18:45:09Z",
      url: "https://github.com/pushkarverma3698/FounderOS/issues/762",
    },
    comments: [],
    pr: null,
    quotaUntil: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHitlGate.mockResolvedValue(null);
});

describe("requeue_antigravity_task", () => {
  it("puts a FAILED issue back to agent:ready after one approval — never files a new issue", async () => {
    currentFacts = factsWith(["antigravity", "agent:failed"]);

    const res = await requeueAntigravityTask.invoke({ issue: 762 });

    expect(mockHitlGate).toHaveBeenCalledOnce();
    expect(mockHitlGate.mock.calls[0]![0]).toMatchObject({ action: "requeue_antigravity_task" });
    expect(gh.removeLabel).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 762, name: "agent:failed" }));
    expect(gh.addLabels).toHaveBeenCalledWith(
      expect.objectContaining({ issue_number: 762, labels: expect.arrayContaining(["agent:ready"]) }),
    );
    expect(kick).toHaveBeenCalledWith(762, "pushkarverma3698/FounderOS", "build");
    expect(audit).toHaveBeenCalledOnce();
    expect(res).toMatch(/#762 is back in Antigravity's queue/);
  });

  it("writes nothing when the founder rejects the card", async () => {
    currentFacts = factsWith(["antigravity", "agent:failed"]);
    mockHitlGate.mockResolvedValueOnce("❌ Rejected by founder.");

    const res = await requeueAntigravityTask.invoke({ issue: 762 });

    expect(res).toBe("❌ Rejected by founder.");
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it("re-opens a closed issue that never got a merged PR", async () => {
    currentFacts = factsWith(["antigravity", "agent:failed"], {
      issue: { ...(factsWith([]).issue as object), state: "closed", labels: ["antigravity", "agent:failed"] },
    });

    await requeueAntigravityTask.invoke({ issue: 762 });

    expect(gh.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 762, state: "open" }));
  });

  it("an issue that is already queued is only nudged — no card, no label change", async () => {
    currentFacts = factsWith(["antigravity", "agent:ready"]);

    const res = await requeueAntigravityTask.invoke({ issue: 762 });

    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(gh.addLabels).not.toHaveBeenCalled();
    expect(kick).toHaveBeenCalledWith(762, "pushkarverma3698/FounderOS", "build");
    expect(res).toMatch(/already queued/i);
  });

  it.each([["agent:working"], ["agent:review"], ["agent:blocked"]])(
    "refuses while the task is %s, and says where it is instead",
    async (label) => {
      currentFacts = factsWith(["antigravity", label]);

      const res = await requeueAntigravityTask.invoke({ issue: 762 });

      expect(mockHitlGate).not.toHaveBeenCalled();
      expect(gh.addLabels).not.toHaveBeenCalled();
      expect(res).toMatch(/Not re-queued/);
      expect(res).toContain("#762");
    },
  );
});

describe("antigravity_task_status", () => {
  it("answers from the recorded facts with no approval, and takes the latest Antigravity issue when none is named", async () => {
    currentFacts = factsWith(["antigravity", "agent:ready"]);

    const res = await antigravityTaskStatus.invoke({});

    expect(gh.listForRepo).toHaveBeenCalledWith(expect.objectContaining({ labels: "antigravity" }));
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(res).toMatch(/^#762 feat: x/);
    expect(res).toMatch(/Queued/);
  });
});
