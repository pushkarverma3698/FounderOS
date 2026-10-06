import { describe, it, expect } from "vitest";
import { specDraftingReply } from "../../../src/tools/dispatch-spec-intake.js";

describe("specDraftingReply: what the founder reads after an agent:spec issue is filed", () => {
  const reply = specDraftingReply({ who: "Claude Code", issue: 77, repo: "pushkarverma3698/FounderOS", url: "https://github.com/x/y/issues/77", engineLabel: "engine:claude" });

  it("says the spec is being drafted, a spec card will follow, and nothing is built before approval", () => {
    expect(reply).toContain("Issue #77");
    expect(reply).toContain("agent:spec");
    expect(reply).toMatch(/spec is being drafted/i);
    expect(reply).toMatch(/spec card/i);
    expect(reply).toMatch(/nothing is built until you approve/i);
    expect(reply).toContain("https://github.com/x/y/issues/77");
  });

  it("never claims the task is queued or will be implemented", () => {
    expect(reply).not.toMatch(/queued|agent:ready|next tick|implement the task|draft PR/i);
  });
});
