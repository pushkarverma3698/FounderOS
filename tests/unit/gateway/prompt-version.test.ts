/**
 * The promptHash stamp must actually move when a prompt moves.
 *
 * Before this module, all four `startTurn` call sites passed the literal
 * "kernel-v3", so the trace field designed to catch prompt regressions was a
 * constant. These tests pin the property that makes the replacement worth
 * having: the hash changes iff the governing prompt corpus changes.
 */
import { describe, it, expect } from "vitest";
import { buildPromptCorpus } from "../../../src/gateway/prompt-version.js";
import { activePromptHash } from "../../../src/infra/trace.js";
import type { WorkerSpec } from "../../../src/kernel/index.js";

type FakeTool = { name: string };

function spec(id: string, prompt: string, toolNames: string[]): WorkerSpec {
  return {
    id,
    description: `${id} worker`,
    prompt,
    tools: toolNames.map((name): FakeTool => ({ name })),
  } as unknown as WorkerSpec;
}

const BASE: WorkerSpec[] = [
  spec("research", "You research things.", ["search_web"]),
  spec("comms", "You send messages.", ["send_email"]),
];

const hashOf = (specs: WorkerSpec[]): string => activePromptHash(buildPromptCorpus(specs));

describe("buildPromptCorpus", () => {
  it("includes every worker prompt and the planner prompt", () => {
    // Arrange / Act
    const corpus = buildPromptCorpus(BASE);

    // Assert
    expect(corpus).toContain("You research things.");
    expect(corpus).toContain("You send messages.");
    expect(corpus).toContain("FounderOS planner");
  });

  it("includes tool names, because they are part of the planner prompt", () => {
    expect(buildPromptCorpus(BASE)).toContain("search_web");
  });

  it("is stable when workers are declared in a different order", () => {
    // A reordering of WORKERS is not a prompt change and must not read as one.
    const reversed = [...BASE].reverse();
    expect(hashOf(reversed)).toBe(hashOf(BASE));
  });

  it("changes when a worker prompt changes", () => {
    const edited = [spec("research", "You research things DIFFERENTLY.", ["search_web"]), BASE[1]!];
    expect(hashOf(edited)).not.toBe(hashOf(BASE));
  });

  it("changes when a tool is added to a worker", () => {
    const withTool = [spec("research", "You research things.", ["search_web", "read_url"]), BASE[1]!];
    expect(hashOf(withTool)).not.toBe(hashOf(BASE));
  });

  it("changes when a worker is removed", () => {
    expect(hashOf([BASE[0]!])).not.toBe(hashOf(BASE));
  });

  it("produces a 12-char hex stamp", () => {
    expect(hashOf(BASE)).toMatch(/^[0-9a-f]{12}$/);
  });
});
