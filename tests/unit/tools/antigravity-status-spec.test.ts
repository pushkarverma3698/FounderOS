/**
 * Pipeline v2: an issue waiting on Pass P or on the founder's spec approval must not read "Not an Antigravity task".
 * The labels exist only while AGENT_PIPELINE_V2=1, so these tests need no flag.
 */

import { describe, it, expect } from "vitest";
import { describeTaskStatus, type TaskFacts } from "../../../src/tools/antigravity-status.js";

const NOW = new Date("2026-10-06T10:00:00Z");

function facts(labels: string[]): TaskFacts {
  return {
    repo: "pushkarverma3698/FounderOS",
    issue: {
      number: 77,
      title: "feat: hide closed issues",
      state: "open",
      labels,
      createdAt: "2026-10-06T09:50:00Z",
      url: "https://github.com/pushkarverma3698/FounderOS/issues/77",
    },
    comments: [],
    pr: null,
    quotaUntil: null,
  };
}

describe("describeTaskStatus: spec stages", () => {
  it("agent:spec: a spec is being drafted, nothing is built, the founder gets a card", () => {
    const text = describeTaskStatus(facts(["antigravity", "agent:spec"]), NOW);
    expect(text).toMatch(/^#77 feat: hide closed issues/);
    expect(text).toMatch(/spec is being drafted/i);
    expect(text).toMatch(/spec card/i);
    expect(text).not.toMatch(/Not an Antigravity task|Queued|working/i);
  });

  it("agent:spec-review: waiting for the founder's approval of the spec card", () => {
    const text = describeTaskStatus(facts(["antigravity", "agent:spec-review"]), NOW);
    expect(text).toMatch(/waiting for your approval/i);
    expect(text).toMatch(/nothing is built/i);
    expect(text).not.toMatch(/Not an Antigravity task|Queued/i);
  });

  it("a later stage wins over a stale spec label (a label swap that half-failed)", () => {
    expect(describeTaskStatus(facts(["antigravity", "agent:spec-review", "agent:working"]), NOW)).toMatch(/working on it/);
    expect(describeTaskStatus(facts(["antigravity", "agent:spec-review", "agent:ready"]), NOW)).toMatch(/Queued/);
  });
});
