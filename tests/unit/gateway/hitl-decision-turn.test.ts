import { describe, it, expect, vi } from "vitest";
import {
  approvalCardTitle,
  hitlDecisionTurn,
  recordHitlDecisionTurn,
  DECISION_TITLE_MAX_CHARS,
} from "../../../src/gateway/hitl-decision-turn.js";

const NOW = new Date("2026-10-05T10:00:00.000Z");
const CARD = JSON.stringify({ action: "send_email", title: "Send email to Anna", summary: "s", preview: "SECRET BODY", args: { to: "a@b.c" } });

describe("approvalCardTitle", () => {
  it("reads the title off the serialized card", () => {
    expect(approvalCardTitle(CARD)).toBe("Send email to Anna");
  });

  it("returns null for missing, unparseable or title-less cards", () => {
    expect(approvalCardTitle(null)).toBeNull();
    expect(approvalCardTitle(undefined)).toBeNull();
    expect(approvalCardTitle("not json")).toBeNull();
    expect(approvalCardTitle(JSON.stringify({ title: "   " }))).toBeNull();
    expect(approvalCardTitle(JSON.stringify({ title: 5 }))).toBeNull();
  });

  it("caps a long title", () => {
    const long = JSON.stringify({ title: "t".repeat(DECISION_TITLE_MAX_CHARS * 2) });
    expect(approvalCardTitle(long)?.length).toBe(DECISION_TITLE_MAX_CHARS);
  });
});

describe("hitlDecisionTurn", () => {
  it("files an approval keyed on the interrupt id", () => {
    expect(hitlDecisionTurn({ interruptId: "abc123", decision: "approved", cardJson: CARD, now: NOW })).toEqual({
      turn_id: "hitl-abc123",
      at: "2026-10-05T10:00:00.000Z",
      user_input: "Approved: Send email to Anna",
      goal: "Approved: Send email to Anna",
      outcome: "done",
      reply: "Approved: Send email to Anna",
    });
  });

  it("files a rejection", () => {
    expect(hitlDecisionTurn({ interruptId: "x", decision: "rejected", cardJson: CARD, now: NOW }).user_input).toBe(
      "Rejected: Send email to Anna",
    );
  });

  it("still files the decision when the card cannot be read", () => {
    expect(hitlDecisionTurn({ interruptId: "x", decision: "rejected", cardJson: null, now: NOW }).user_input).toBe(
      "Rejected an approval card",
    );
  });

  it("never copies the card preview or args into the row", () => {
    const row = JSON.stringify(hitlDecisionTurn({ interruptId: "x", decision: "approved", cardJson: CARD, now: NOW }));
    expect(row).not.toContain("SECRET BODY");
    expect(row).not.toContain("a@b.c");
  });
});

describe("recordHitlDecisionTurn", () => {
  it("writes the row under the thread", () => {
    const record = vi.fn().mockResolvedValue(undefined);
    recordHitlDecisionTurn("t:1", { interruptId: "i1", decision: "approved", cardJson: CARD, now: NOW }, record);
    expect(record).toHaveBeenCalledWith("t:1", expect.objectContaining({ turn_id: "hitl-i1" }));
  });

  it("a failed write is swallowed", async () => {
    const record = vi.fn().mockRejectedValue(new Error("db down"));
    expect(() =>
      recordHitlDecisionTurn("t:1", { interruptId: "i1", decision: "rejected", cardJson: CARD, now: NOW }, record),
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
