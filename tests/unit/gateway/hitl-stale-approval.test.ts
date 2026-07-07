/**
 * REGRESSION (H1) — an approval decision must be bound to the SPECIFIC
 * interrupt it was rendered for, not "whatever is currently pending".
 * ============================================================================
 * Before this fix, Telegram callback data was the literal string
 * "approve"/"reject" and the web `/api/v1/sessions/:id/hitl/:decision` route
 * resumed whatever the thread happened to be paused on. If the pending action
 * changed between the card being rendered and the founder tapping it (a
 * guard-retry re-invoke, a second card, a fresh turn), the tap silently
 * resumed the WRONG action (TOCTOU).
 *
 * `resumeOfficeSession`/`resumeOffice` now accept an `expectedInterruptId`
 * (the id embedded in the tapped card). When provided and it no longer
 * matches the interrupt actually pending on the thread, the decision is
 * refused — no checkpoint clear, no resolveInterrupt, no invoke — and the
 * founder sees a "no longer current" notice instead.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const clearThreadCheckpoints = vi.fn(async () => 1);
const getOffice = vi.fn();
const cancelPendingApprovals = vi.fn(async () => 1);
const getPendingInterrupt = vi.fn(async (_threadId: string) => null as { interrupt_id: string } | null);
const resolveInterrupt = vi.fn(async () => true);
const getShellHitlPendingApproval = vi.fn(async () => null);
const getGithubWriteHitlPendingApproval = vi.fn(async () => null);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/gateway/shell-hitl-fast-path.js", () => ({
  getShellHitlPendingApproval,
  invokeShellHitlFastPath: vi.fn(async () => false),
  isShellHitlRequest: vi.fn(() => false),
  resumeShellHitlFastPath: vi.fn(),
  shellFastPathThreadId: (threadId: string) => `${threadId}:shell-fp`,
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

const { resumeOffice } = await import("../../../src/gateway/office-run.js");

interface Reply {
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts?: any;
}

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

describe("resumeOffice — stale approval binding (H1)", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    cancelPendingApprovals.mockClear();
    resolveInterrupt.mockClear();
    getPendingInterrupt.mockReset();
    getShellHitlPendingApproval.mockClear();
    getShellHitlPendingApproval.mockResolvedValue(null);
    getOffice.mockReset();
  });

  it("refuses a decision whose expectedInterruptId no longer matches what's pending", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "current-row-id" });
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));
    const replies: Reply[] = [];

    await resumeOffice(fakeCtx(replies), "rejected", "stale-id-from-old-card");

    expect(clearThreadCheckpoints).not.toHaveBeenCalled();
    expect(resolveInterrupt).not.toHaveBeenCalled();
    expect(cancelPendingApprovals).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text.toLowerCase()).toContain("no longer current");
  });

  it("proceeds normally when expectedInterruptId matches what's pending", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "match-id-1" });
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));

    await resumeOffice(fakeCtx([]), "rejected", "match-id-1");

    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);
    expect(resolveInterrupt).toHaveBeenCalledWith("match-id-1", "rejected");
  });

  it("skips the binding check entirely when no expectedInterruptId is given (legacy cards)", async () => {
    getPendingInterrupt.mockResolvedValue({ interrupt_id: "whatever-is-pending" });
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));

    await resumeOffice(fakeCtx([]), "rejected");

    expect(clearThreadCheckpoints).toHaveBeenCalledTimes(1);
  });

  it("shell fast path: refuses a stale decision bound to a different shell approval", async () => {
    const shellApproval = {
      kind: "approval",
      action: "run_shell",
      title: "💻 Run: ls -la?",
      summary: "cwd: ~",
      preview: "ls -la",
      args: {},
    };
    getShellHitlPendingApproval.mockResolvedValue(shellApproval);
    // Row lives under the shell-suffixed thread id.
    getPendingInterrupt.mockImplementation(async (threadId: string) =>
      threadId.endsWith(":shell-fp") ? { interrupt_id: "current-shell-row" } : null,
    );
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));

    await resumeOffice(fakeCtx([]), "rejected", "stale-shell-id");

    expect(clearThreadCheckpoints).not.toHaveBeenCalled();
    expect(resolveInterrupt).not.toHaveBeenCalled();
  });

  it("shell fast path: resolves the interrupt on the SHELL-suffixed thread id, not the base thread (latent-bug fix)", async () => {
    const shellApproval = {
      kind: "approval",
      action: "run_shell",
      title: "💻 Run: ls -la?",
      summary: "cwd: ~",
      preview: "ls -la",
      args: {},
    };
    getShellHitlPendingApproval.mockResolvedValue(shellApproval);
    getPendingInterrupt.mockImplementation(async (threadId: string) =>
      threadId.endsWith(":shell-fp") ? { interrupt_id: "current-shell-row" } : null,
    );
    getOffice.mockResolvedValue(pausedOffice(vi.fn()));

    await resumeOffice(fakeCtx([]), "rejected");

    // Before the fix this looked up getPendingInterrupt(session.threadId) — the
    // BASE thread, which never has a row for shell approvals — so the DB row
    // was never resolved and sat "pending" until TTL expiry.
    expect(resolveInterrupt).toHaveBeenCalledWith("current-shell-row", "rejected");
  });
});
