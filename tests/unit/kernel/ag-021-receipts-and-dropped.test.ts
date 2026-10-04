import { describe, it, expect } from "vitest";
import { founderReceiptsBlock, type StepResult, type KernelStateType } from "../../../src/kernel/index.js";
import { renderFailureCard, failureCardFor } from "../../../src/gateway/failure-card.js";

describe("AG-021: receipt verification footer & hitl_rejected rendering", () => {
  it("AC1: mission with one ok github_read receipt and one failed step produces no ✓", () => {
    const results: StepResult[] = [
      {
        step_id: "s1",
        status: "ok",
        output: { data: "code" },
        tool_receipts: [
          {
            tool: "github_read",
            args_hash: "a".repeat(64),
            result_digest: "b".repeat(64),
            ok: true,
            at: new Date().toISOString(),
          },
        ],
      },
      {
        step_id: "s2",
        status: "failed",
        failure: {
          step_id: "s2",
          stage: "tool",
          component: "engineering",
          message: "build failed",
          retryable: false,
        },
        tool_receipts: [],
      },
    ];

    const block = founderReceiptsBlock(results);
    expect(block).not.toContain("✓");
    expect(block).toBe("");
  });

  it("AC1 (read-only tool): mission with one ok github_read receipt and no failed step produces no ✓", () => {
    const results: StepResult[] = [
      {
        step_id: "s1",
        status: "ok",
        output: { data: "code" },
        tool_receipts: [
          {
            tool: "github_read",
            args_hash: "a".repeat(64),
            result_digest: "b".repeat(64),
            ok: true,
            at: new Date().toISOString(),
          },
        ],
      },
    ];

    const block = founderReceiptsBlock(results);
    expect(block).not.toContain("✓");
    expect(block).toBe("");
  });

  it("AC2: mission with one ok gated send_email receipt still prints ✓ 1 action completed and verified", () => {
    const results: StepResult[] = [
      {
        step_id: "s1",
        status: "ok",
        output: { summary: "email sent" },
        tool_receipts: [
          {
            tool: "send_email",
            args_hash: "a".repeat(64),
            result_digest: "b".repeat(64),
            ok: true,
            at: new Date().toISOString(),
          },
        ],
      },
    ];

    const block = founderReceiptsBlock(results);
    expect(block).toBe("\n\n—\n✓ 1 action completed and verified");
  });

  it("AC3: hitl_rejected renders exactly 👍 Dropped. Nothing was sent.", () => {
    const state = {
      failure: {
        step_id: "s1",
        stage: "hitl_rejected",
        component: "send_email",
        message: "Rejected by founder.",
        retryable: false,
      },
    } as unknown as KernelStateType;

    const rendered = renderFailureCard(state as never, { retry: false });
    expect(rendered).toBe("👍 Dropped. Nothing was sent.");

    const card = failureCardFor(state as never, { turnId: "dummy-turn" });
    expect(card).not.toBeNull();
    expect(card?.html).toBe("👍 Dropped. Nothing was sent.");
    expect(card?.keyboard).toBeUndefined();
  });
});
