import { describe, expect, it } from "vitest";
import { labelsFromReason, loadQuestionSources } from "../../../src/gateway/questions-data.js";

describe("questions-data", () => {
  it("reads the labels out of a lane reason, ignoring the (+N more) tail", () => {
    expect(labelsFromReason("3 required question(s) unanswered: A; B; C (+2 more)")).toEqual(["A", "B", "C"]);
    expect(labelsFromReason("Greenhouse emails a confirmation code at submit; you type it in")).toEqual([]);
  });

  it("prefers the snapshot's required questions (with types) over the clipped reason", async () => {
    const snap = { summary: { unanswered: [{ label: "Full question text", required: true, fieldType: "text" }, { label: "Optional one", required: false, fieldType: "text" }] } };
    const out = await loadQuestionSources(
      "p",
      new Date(0),
      {
        rows: async () => [{ id: "a", company: "Acme", reason: "2 required question(s) unanswered: Full qu…; X" }, { id: "b", company: "Birch", reason: "1 required question(s) unanswered: Only reason" }],
        snapshot: ((id: string) => (id === "a" ? snap : null)) as never,
      },
    );
    expect(out).toEqual([
      { rowId: "a", company: "Acme", label: "Full question text", fieldType: "text" },
      { rowId: "b", company: "Birch", label: "Only reason" },
    ]);
  });
});
