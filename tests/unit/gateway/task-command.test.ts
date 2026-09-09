/**
 * Unit tests for /task — the registered entry point to the Claude↔Antigravity loop.
 *
 * Resolution is pure code and happens BEFORE any model call, so an unknown or
 * ambiguous repo hint costs nothing and cannot retarget a dispatch. That is the whole
 * reason the selector is not left to the planner.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";

const { parseTaskArgs, buildTaskInstruction, handleTask } = await import(
  "../../../src/gateway/task-command.js"
);

function fakeCtx(match: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    match,
    reply: async (text: string) => {
      replies.push(text);
    },
  } as unknown as Context;
  return { ctx, replies };
}

describe("parseTaskArgs", () => {
  it("defaults to FounderOS when no repo is named", () => {
    const parsed = parseTaskArgs("fix the flaky CSV export");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.repo).toBe("pushkarverma3698/FounderOS");
    expect(parsed.args.text).toBe("fix the flaky CSV export");
  });

  it("resolves a short repo hint and strips it from the text", () => {
    const parsed = parseTaskArgs("repo:hulda fix the hero layout");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.repo).toBe("pushkarverma3698/House-of-Hulda-Website-frontend");
    expect(parsed.args.text).toBe("fix the hero layout");
  });

  it("accepts a full slug as the hint", () => {
    const parsed = parseTaskArgs("repo:pushkarverma3698/FounderOS tidy the logs");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.repo).toBe("pushkarverma3698/FounderOS");
  });

  it("honours repo: ONLY as the first token", () => {
    // Otherwise "mention repo:foo in the readme" silently retargets the dispatch to
    // whatever "foo" resolves to — the instruction was about the string, not the target.
    const parsed = parseTaskArgs("mention repo:hulda in the readme");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.args.repo).toBe("pushkarverma3698/FounderOS");
    expect(parsed.args.text).toBe("mention repo:hulda in the readme");
  });

  it("refuses an unknown repo hint and names the allowlist", () => {
    const parsed = parseTaskArgs("repo:linkedin-growth-engine-v2 do a thing");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("linkedin-growth-engine-v2");
    expect(parsed.message).toContain("FounderOS");
    expect(parsed.message).toContain("House-of-Hulda-Website-frontend");
  });

  it("refuses an ambiguous hint instead of guessing", () => {
    // "o" matches both repo names. Picking the first would file the issue against a
    // repo the founder never named.
    const parsed = parseTaskArgs("repo:o do a thing");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toMatch(/ambiguous|matches more than one/i);
    expect(parsed.message).toContain("FounderOS");
  });

  it("returns usage for empty input", () => {
    const empty = parseTaskArgs("   ");
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.message).toContain("/task");
  });

  it("returns usage when a repo is named but no work is described", () => {
    const parsed = parseTaskArgs("repo:hulda");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("/task");
  });
});

describe("buildTaskInstruction", () => {
  it("names the resolved repo and the tool the planner must call", () => {
    const instruction = buildTaskInstruction({
      repo: "pushkarverma3698/House-of-Hulda-Website-frontend",
      text: "fix the hero layout",
    });

    expect(instruction).toContain("dispatch_antigravity_task");
    expect(instruction).toContain("pushkarverma3698/House-of-Hulda-Website-frontend");
    expect(instruction).toContain("fix the hero layout");
  });

  it("tells the planner to dispatch rather than implement the work itself", () => {
    // Without this the planner happily edits files and never files the issue, and the
    // founder's /task looks like it worked while the loop never ran.
    const instruction = buildTaskInstruction({
      repo: "pushkarverma3698/FounderOS",
      text: "fix the flaky CSV export",
    });
    expect(instruction).toMatch(/do not implement|don't implement/i);
  });
});

describe("handleTask", () => {
  it("hands a composed instruction to the ordinary kernel turn", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("fix the flaky CSV export");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).toHaveBeenCalledTimes(1);
    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("dispatch_antigravity_task");
  });

  it("refuses an off-allowlist repo WITHOUT spending a model call", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies } = fakeCtx("repo:someone-else/private-thing do a thing");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("House-of-Hulda-Website-frontend");
  });

  it("replies with usage on empty input and spends nothing", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies } = fakeCtx("");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("/task");
  });
});
