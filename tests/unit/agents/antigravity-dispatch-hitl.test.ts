/**
 * Unit tests for dispatchAntigravityTask agent tool:
 * HITL gating, idempotency, and audit logging.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockHasBeenAudited = vi.fn();
const mockWriteAuditEntry = vi.fn();
const mockDispatchExecute = vi.fn();

vi.mock("../../../src/agents/agent-tools/hitl.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    hitlGate: mockHitlGate,
  };
});

vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: mockHasBeenAudited,
  writeAuditEntry: mockWriteAuditEntry,
  // Dispatch resolves against the hardcoded allowlist PLUS repos this instance
  // created. No created repos in these cases — the hardcoded list is the subject.
  listRegisteredDispatchRepos: async () => [],
}));

vi.mock("../../../src/tools/dispatch-antigravity.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    dispatchAntigravityTool: {
      execute: mockDispatchExecute,
    },
  };
});

const { dispatchAntigravityTask } = await import(
  "../../../src/agents/agent-tools/antigravity.js"
);

describe("dispatchAntigravityTask agent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue({ written: true });
    mockHitlGate.mockResolvedValue(null); // approved
  });

  it("skips execution if already audited (idempotency)", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    const result = await dispatchAntigravityTask.invoke({
      title: "feat: 13k ATS scaling",
      goal: "Implement token bucket",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Working rate limiter",
      verification: "pnpm test",
    });

    expect(result).toContain("Already dispatched");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockDispatchExecute).not.toHaveBeenCalled();
  });

  it("returns rejection message when rejected by founder at HITL gate", async () => {
    mockHitlGate.mockResolvedValue("❌ Rejected by founder.");

    const result = await dispatchAntigravityTask.invoke({
      title: "feat: risky change",
      goal: "Modify kernel",
      scope: "src/kernel/planner.ts",
      expected: "Experimental change",
      verification: "pnpm test",
    });

    expect(result).toBe("❌ Rejected by founder.");
    expect(mockDispatchExecute).not.toHaveBeenCalled();
  });

  it("calls dispatchAntigravityTool and writes audit log upon HITL approval", async () => {
    mockDispatchExecute.mockResolvedValue({
      success: true,
      data: {
        issue_number: 525,
        issue_url: "https://github.com/pushkarverma3698/FounderOS/issues/525",
        title: "feat: 13k ATS scaling",
        repo: "pushkarverma3698/FounderOS",
      },
    });

    const result = await dispatchAntigravityTask.invoke({
      title: "feat: 13k ATS scaling",
      goal: "Implement token bucket and ETag caching",
      scope: "src/tools/jobhunt/free-ats-source.ts",
      expected: "Per-domain limiters and ETag conditional GETs",
      verification: "pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate",
    });

    expect(mockHitlGate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispatch_antigravity_task",
        title: "🤖 Dispatch task to Google Antigravity?",
        summary: expect.stringContaining("pushkarverma3698/FounderOS"),
      }),
      expect.anything(),
    );

    expect(mockDispatchExecute).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispatch_antigravity_task",
        payload: expect.objectContaining({
          issue_number: 525,
          repo: "pushkarverma3698/FounderOS",
        }),
      }),
    );

    expect(result).toContain("✅ Dispatched to Google Antigravity: Issue #525");
    expect(result).toContain("https://github.com/pushkarverma3698/FounderOS/issues/525");
  });

  it("surfaces failure if underlying execution fails", async () => {
    mockDispatchExecute.mockResolvedValue({
      success: false,
      error: "GitHub token missing",
    });

    const result = await dispatchAntigravityTask.invoke({
      title: "feat: task",
      goal: "goal",
      scope: "src/tools/free-ats.ts",
      expected: "expected",
      verification: "pnpm test",
    });

    expect(result).toContain("❌ Failed to dispatch task to Antigravity: GitHub token missing");
  });

  it("refuses an off-allowlist repo BEFORE showing an approval card", async () => {
    // The old code caught the resolve failure and fell back to FounderOS, so the card
    // said "Open agent:ready issue on pushkarverma3698/FounderOS" for a request that
    // named a different repo. The founder would approve a target the card misreported.
    const result = await dispatchAntigravityTask.invoke({
      title: "feat: task",
      goal: "goal",
      scope: "src/index.ts",
      expected: "expected",
      verification: "pnpm test",
      repo: "someone-else/private-thing",
    });

    expect(result).toContain("not on the Antigravity dispatch allowlist");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockDispatchExecute).not.toHaveBeenCalled();
  });

  it("names the resolved repo in the approval card for the second allowlisted repo", async () => {
    mockDispatchExecute.mockResolvedValue({
      success: true,
      data: {
        issue_number: 12,
        issue_url: "https://github.com/pushkarverma3698/House-of-Hulda-Website-frontend/issues/12",
        title: "fix: hero layout",
        repo: "pushkarverma3698/House-of-Hulda-Website-frontend",
      },
    });

    await dispatchAntigravityTask.invoke({
      title: "fix: hero layout",
      goal: "goal",
      scope: "src/components/Hero.tsx",
      expected: "expected",
      verification: "pnpm build",
      repo: "pushkarverma3698/House-of-Hulda-Website-frontend",
    });

    expect(mockHitlGate).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("pushkarverma3698/House-of-Hulda-Website-frontend"),
      }),
      expect.anything(),
    );
  });
});
