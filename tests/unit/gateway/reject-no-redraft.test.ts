/**
 * Regression: rejecting an HITL approval must TERMINATE the turn — it must never
 * resume the ReAct agent, because the agent treats the rejection tool-result as
 * feedback and re-drafts, firing interrupt() again → an endless stream of
 * approval cards the founder can't escape (reproduced live 2026-06-12).
 *
 * Root cause: src/agents/agent-tools/hitl.ts returns "❌ Rejected by founder."
 * to the agent. The fix lives in resumeOffice: on "rejected" we abandon the
 * paused task deterministically (clear the thread + confirm) instead of
 * resuming into the agent. Side effects only run after an "approved" resume, so
 * action_log stays empty (safety holds).
 *
 * Contract under test:
 *   reject → office.invoke is NEVER called (no resume into the agent)
 *          → clearThreadCheckpoints is called (paused task abandoned)
 *          → the founder gets a plain rejection confirmation, NOT a new card
 *            (no inline keyboard / reply_markup).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const clearThreadCheckpoints = vi.fn(async () => 1);
const getOffice = vi.fn();
const cancelPendingApprovals = vi.fn(async () => 1);
const getPendingInterrupt = vi.fn(async () => null);
const resolveInterrupt = vi.fn(async () => true);

const getShellHitlPendingApproval = vi.fn(async () => null);
const getGithubWriteHitlPendingApproval = vi.fn(async () => null);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/gateway/shell-hitl-fast-path.js", () => ({
  getShellHitlPendingApproval,
  invokeShellHitlFastPath: vi.fn(async () => false),
  isShellHitlRequest: vi.fn(() => false),
  resumeShellHitlFastPath: vi.fn(),
}));
vi.mock("../../../src/gateway/github-write-fast-path.js", () => ({
  getGithubWriteHitlPendingApproval,
  invokeGithubWriteFastPath: vi.fn(async () => false),
  extractGithubWriteParams: vi.fn(() => null),
  resumeGithubWriteFastPath: vi.fn(),
  githubWriteFastPathThreadId: (threadId: string) => `${threadId}:github-write-fp`,
}));
vi.mock("../../../src/db/queries.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/db/queries.js")>()),
  cancelPendingApprovals,
  getPendingInterrupt,
  resolveInterrupt,
}));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice };
});

const { resumeOffice, buildRejectionConfirmation } = await import("../../../src/gateway/office-run.js");

interface Reply {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

/** Fake grammy Context that records every reply. */
function fakeCtx(replies: Reply[]) {
  return {
    chat: { id: 6775330211 },
    from: { id: 6775330211 },
    reply: vi.fn(async (text: string, opts?: unknown) => {
      replies.push({ text, opts });
    }),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** Fake office whose thread is paused on a pending send_email approval. */
function pausedOffice(invoke: ReturnType<typeof vi.fn>) {
  const approval = {
    kind: "approval",
    action: "send_email",
    title: "📧 Send email to alex@example.com?",
    summary: "Subject: Hello",
    preview: "Hi Alex...",
    args: {},
  };
  return {
    invoke,
    getState: vi.fn(async () => ({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: approval }] }],
    })),
  };
}

describe("resumeOffice — rejection terminates the turn (no re-draft loop)", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    cancelPendingApprovals.mockClear();
    getShellHitlPendingApproval.mockClear();
    getShellHitlPendingApproval.mockResolvedValue(null);
    getOffice.mockReset();
  });

  it("does NOT call office.invoke on rejection (never resumes into the agent)", async () => {
    const invoke = vi.fn();
    getOffice.mockResolvedValue(pausedOffice(invoke));
    const replies: Reply[] = [];

    await resumeOffice(fakeCtx(replies), "rejected");

    expect(invoke).not.toHaveBeenCalled();
  });

  it("clears the paused thread so the abandoned task can never re-fire", async () => {
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));
    const replies: Reply[] = [];

    await resumeOffice(fakeCtx(replies), "rejected");

    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("replies with a rejection confirmation, NOT a new approval card", async () => {
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));
    const replies: Reply[] = [];

    await resumeOffice(fakeCtx(replies), "rejected");

    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.text.toLowerCase()).toMatch(/cancel|reject/);
    // A new approval card would carry an inline keyboard — there must be none.
    expect(reply.opts?.reply_markup).toBeUndefined();
  });

  it("cancels ghost pending HITL approvals on rejection (G9 — no stale-reminder nag)", async () => {
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));

    await resumeOffice(fakeCtx([]), "rejected");

    expect(cancelPendingApprovals).toHaveBeenCalledWith("turicks:6775330211");
  });

  it("buildRejectionConfirmation names the rejected action for the founder", () => {
    const msg = buildRejectionConfirmation({
      kind: "approval",
      action: "send_email",
      title: "📧 Send email to alex@example.com?",
      summary: "Subject: Hello",
      preview: "Hi Alex...",
      args: {},
    });
    expect(msg.toLowerCase()).toContain("cancel");
    expect(msg).toContain("Send email to alex@example.com");
  });
});
