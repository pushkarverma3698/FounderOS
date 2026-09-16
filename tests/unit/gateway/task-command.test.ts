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

// ── Repos created after this code was compiled ───────────────────────────────
//
// /task has to reach a project started from Telegram last Tuesday, or "start a new
// project and build me X" stops halfway with the founder's own repo refused.

describe("/task against a repo this instance created", () => {
  const CREATED = ["pushkarverma3698/turicks-pricing-api"];

  it("resolves a created repo by short hint", () => {
    const parsed = parseTaskArgs("repo:pricing add rate limiting", CREATED);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.repo).toBe("pushkarverma3698/turicks-pricing-api");
  });

  it("still refuses a repo nobody created and nobody hardcoded", () => {
    const parsed = parseTaskArgs("repo:someone-else/thing do a thing", CREATED);
    expect(parsed.ok).toBe(false);
  });

  it("names created repos in the refusal, so the list the founder sees is the real one", () => {
    const parsed = parseTaskArgs("repo:nope do a thing", CREATED);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain("turicks-pricing-api");
  });

  it("passes created repos through handleTask", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("repo:pricing add rate limiting");

    await handleTask(ctx, {
      runKernelText,
      listRegisteredRepos: async () => CREATED,
    });

    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("pushkarverma3698/turicks-pricing-api");
  });

  it("still dispatches to the hardcoded repos when the registry read fails", async () => {
    // A registry that cannot be read must not take /task down for FounderOS.
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("fix the flaky CSV export");

    await handleTask(ctx, {
      runKernelText,
      listRegisteredRepos: async () => {
        throw new Error("db down");
      },
    });

    expect(runKernelText).toHaveBeenCalledTimes(1);
  });
});

// ── /newproject ──────────────────────────────────────────────────────────────

const { parseNewProjectArgs, buildNewProjectInstruction, handleNewProject } = await import(
  "../../../src/gateway/task-command.js"
);

describe("parseNewProjectArgs", () => {
  it("takes the first token as the repo name and the rest as the description", () => {
    const parsed = parseNewProjectArgs("turicks-pricing-api a pricing API for Turicks");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.args.name).toBe("turicks-pricing-api");
      expect(parsed.args.description).toBe("a pricing API for Turicks");
    }
  });

  it("accepts a bare name with no description", () => {
    const parsed = parseNewProjectArgs("scratchpad");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.description).toBe("");
  });

  it("shows usage for an empty argument", () => {
    const parsed = parseNewProjectArgs("   ");
    expect(parsed.ok).toBe(false);
  });

  it("refuses an illegal repo name in the gateway, before any model call", () => {
    // Same reasoning as the repo hint on /task: a name GitHub would rewrite produces a
    // repo whose real name differs from the registered one.
    const parsed = parseNewProjectArgs("my/project something");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/slash/i);
  });
});

describe("handleNewProject", () => {
  it("asks the kernel to call create_project_repo, naming the repo", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("turicks-pricing-api pricing API");

    await handleNewProject(ctx, { runKernelText });

    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("create_project_repo");
    expect(instruction).toContain("turicks-pricing-api");
  });

  it("refuses an illegal name without spending a model call", async () => {
    // Note the grammar: "/newproject my cool thing" is NOT an error — it means a repo
    // called "my" described as "cool thing". The approval card prints the resolved
    // name, which is where a misread gets caught. Only characters GitHub would reject
    // or rewrite are refused here.
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies } = fakeCtx("proj#1 a pricing thing");

    await handleNewProject(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies[0]).toBeTruthy();
  });

  it("defaults to private, and says so in the instruction", () => {
    const instruction = buildNewProjectInstruction({ name: "x", description: "" });
    expect(instruction).toMatch(/private/i);
  });
});
