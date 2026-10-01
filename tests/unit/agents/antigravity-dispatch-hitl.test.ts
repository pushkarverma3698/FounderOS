/**
 * Unit tests for dispatchAntigravityTask agent tool:
 * HITL gating, idempotency, audit logging, and the brief lint that runs BEFORE the card.
 *
 * The lint itself is covered in dispatch-antigravity.test.ts and agent-brief-lint.test.ts. It
 * is stubbed here so these cases stay about ordering and what the founder is (not) asked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockHitlGate = vi.fn();
const mockHasBeenAudited = vi.fn();
const mockWriteAuditEntry = vi.fn();
const mockDispatchExecute = vi.fn();
const mockLint = vi.fn();

const LINT_OK = { ok: true, missing: [], missingHeadings: [], emptyHeadings: [], missingPaths: [], otherProblems: [], warnings: [] };

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
    lintDispatchBrief: mockLint,
  };
});

const { dispatchAntigravityTask } = await import(
  "../../../src/agents/agent-tools/antigravity.js"
);
const { formatAntigravityIssueBody } = await import("../../../src/tools/dispatch-antigravity.js");
const { CARD_PREVIEW_MAX_CHARS } = await import("../../../src/tools/dispatch-brief-preview.js");

describe("dispatchAntigravityTask agent tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue({ written: true });
    mockHitlGate.mockResolvedValue(null); // approved
    mockLint.mockResolvedValue(LINT_OK);
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
    expect(mockLint).not.toHaveBeenCalled();
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

describe("dispatchAntigravityTask agent tool: the brief lint runs before the approval card", () => {
  const BRIEF = {
    title: "fix: retry budget is spent on 4xx",
    goal: "Stop the sweep spending its retry budget on 4xx responses.",
    scope: "src/tools/jobhunt/free-ats-source.ts",
    expected: "A 4xx is a permanent failure and is never retried.",
    verification: "pnpm test tests/unit/tools/free-ats-source.test.ts && pnpm gate",
    problem: "Every 404 board is retried three times.",
    evidence: "The sweep log of 2026-09-20 shows 1,204 retries on 404s.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockHasBeenAudited.mockResolvedValue(false);
    mockWriteAuditEntry.mockResolvedValue({ written: true });
    mockHitlGate.mockResolvedValue(null);
    mockLint.mockResolvedValue(LINT_OK);
  });

  it("never shows a card for a brief that will be rejected: no approval, no filing, no audit row", async () => {
    mockLint.mockResolvedValue({
      ok: false,
      missing: [],
      missingHeadings: ["Evidence"],
      emptyHeadings: [],
      missingPaths: ["src/agents/supervisor.ts"],
      otherProblems: [],
      warnings: [],
    });

    const result = await dispatchAntigravityTask.invoke({ ...BRIEF, evidence: "" });

    expect(result).toContain("❌ Brief rejected: nothing was filed on pushkarverma3698/FounderOS.");
    expect(result).toContain('1. Section "## Evidence" is missing. Pass it in the `evidence` input.');
    expect(result).toContain("2. `src/agents/supervisor.ts` does not exist in pushkarverma3698/FounderOS.");
    expect(mockHitlGate).not.toHaveBeenCalled();
    expect(mockDispatchExecute).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("checks idempotency first: an already-dispatched brief costs no lint at all", async () => {
    mockHasBeenAudited.mockResolvedValue(true);

    await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(mockLint).not.toHaveBeenCalled();
  });

  it("lints the exact body it will file, against the repo it resolved", async () => {
    await dispatchAntigravityTask.invoke({ ...BRIEF, new_files: "src/tools/new-thing.ts", constraints: "Keep the API." });

    const expected = formatAntigravityIssueBody({ ...BRIEF, newFiles: "src/tools/new-thing.ts", constraints: "Keep the API." });
    expect(mockLint).toHaveBeenCalledWith({ owner: "pushkarverma3698", repo: "FounderOS" }, expected);
  });

  it("lints ABOVE the gate, read-only: the row-before-interrupt and no-side-effect-before-approval rules still hold", async () => {
    await dispatchAntigravityTask.invoke({ ...BRIEF });

    const lintOrder = mockLint.mock.invocationCallOrder[0] as number;
    const gateOrder = mockHitlGate.mock.invocationCallOrder[0] as number;
    expect(lintOrder).toBeLessThan(gateOrder);
    // Nothing that acts on GitHub, the audit table or the dispatcher ran before approval.
    expect(mockDispatchExecute.mock.invocationCallOrder[0] as number).toBeGreaterThan(gateOrder);
    expect(mockWriteAuditEntry.mock.invocationCallOrder[0] ?? Infinity).toBeGreaterThan(gateOrder);
  });

  it("re-lints on the resumed run instead of trusting the first pass (the memo lives inside the lint)", async () => {
    // hitlGate re-runs the tool from the top on resume. The wrapper must not cache anything itself.
    await dispatchAntigravityTask.invoke({ ...BRIEF });
    await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect(mockLint).toHaveBeenCalledTimes(2);
  });

  it("shows the founder a budgeted digest, so Verification and Acceptance are on the card", async () => {
    await dispatchAntigravityTask.invoke({ ...BRIEF, goal: "goal ".repeat(4000), expected: "expected ".repeat(4000) });

    const gate = mockHitlGate.mock.calls[0]?.[0] as { preview: string };
    expect(gate.preview.length).toBeLessThanOrEqual(CARD_PREVIEW_MAX_CHARS);
    expect(gate.preview).toContain("Verify: pnpm test tests/unit/tools/free-ats-source.test.ts");
    expect(gate.preview).toContain("Accept: ");
    expect(gate.preview).toContain("Also filed: Problem, Evidence, Constraints, Forbidden");
  });

  it("puts the paths the lint could not verify on the card, and in the reply once dispatched", async () => {
    const warning = "Could not verify 1 of 1 path (Service Unavailable); not blocking the dispatch: src/app.ts.";
    mockLint.mockResolvedValue({ ...LINT_OK, warnings: [warning] });
    mockDispatchExecute.mockResolvedValue({
      success: true,
      data: {
        issue_number: 9,
        issue_url: "https://github.com/pushkarverma3698/FounderOS/issues/9",
        title: "fix: x",
        repo: "pushkarverma3698/FounderOS",
        warnings: [warning],
      },
    });

    const result = await dispatchAntigravityTask.invoke({ ...BRIEF });

    expect((mockHitlGate.mock.calls[0]?.[0] as { preview: string }).preview).toContain("Not verified: Could not verify 1 of 1 path");
    expect(result).toContain("✅ Dispatched to Google Antigravity: Issue #9");
    expect(result).toContain(`⚠️ ${warning}`);
  });

  it("carries problem, evidence, constraints and new_files into the approval args and into execute()", async () => {
    mockDispatchExecute.mockResolvedValue({
      success: true,
      data: { issue_number: 3, issue_url: "u", title: "t", repo: "pushkarverma3698/FounderOS" },
    });

    await dispatchAntigravityTask.invoke({ ...BRIEF, constraints: "Keep the API.", new_files: "src/tools/new-thing.ts" });

    const gate = mockHitlGate.mock.calls[0]?.[0] as { args: Record<string, unknown> };
    expect(gate.args).toMatchObject({
      problem: BRIEF.problem,
      evidence: BRIEF.evidence,
      constraints: "Keep the API.",
      new_files: "src/tools/new-thing.ts",
    });
    expect(mockDispatchExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        problem: BRIEF.problem,
        evidence: BRIEF.evidence,
        constraints: "Keep the API.",
        new_files: "src/tools/new-thing.ts",
      }),
    );
  });
});
