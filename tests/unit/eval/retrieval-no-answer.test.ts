import { describe, it, expect } from "vitest";
import { RETRIEVAL_NO_ANSWER_CASES } from "../../../src/eval/retrieval-no-answer.js";
import { RETRIEVAL_GOLDEN_SET } from "../../../src/eval/retrieval-golden.js";

describe("RETRIEVAL_NO_ANSWER_CASES", () => {
  it("has at least 5 cases with unique ids that do not collide with the golden set", () => {
    expect(RETRIEVAL_NO_ANSWER_CASES.length).toBeGreaterThanOrEqual(5);
    const ids = RETRIEVAL_NO_ANSWER_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const golden = new Set(RETRIEVAL_GOLDEN_SET.map((c) => c.id));
    expect(ids.some((id) => golden.has(id))).toBe(false);
  });
});
