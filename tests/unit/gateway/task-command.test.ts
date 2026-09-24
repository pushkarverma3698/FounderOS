/**
 * Unit tests for /task — the registered entry point to the Claude↔Antigravity loop.
 *
 * Resolution is pure code and happens BEFORE any model call, so an unknown or
 * ambiguous repo hint costs nothing and cannot retarget a dispatch. That is the whole
 * reason the selector is not left to the planner.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";

const {
  parseTaskArgs,
  buildTaskInstruction,
  handleTask,
  handleRepoChoice,
  handleRepoReply,
  stripTaskCommand,
} = await import("../../../src/gateway/task-command.js");

interface FakeCtx {
  ctx: Context;
  replies: string[];
  /** The `reply_markup` of each reply, so button behaviour is assertable. */
  markups: unknown[];
}

function fakeCtx(match: string, over: Record<string, unknown> = {}): FakeCtx {
  const replies: string[] = [];
  const markups: unknown[] = [];
  const ctx = {
    match,
    message: { message_id: 11, text: `/task ${match}` },
    reply: async (text: string, opts?: { reply_markup?: unknown }) => {
      replies.push(text);
      markups.push(opts?.reply_markup);
    },
    answerCallbackQuery: async () => undefined,
    editMessageReplyMarkup: async () => undefined,
    ...over,
  } as unknown as Context;
  return { ctx, replies, markups };
}

/**
 * A tapped repo button; `repliedTo` is the message the question was attached to.
 *
 * `messageId` defaults to a random id — each call is a DIFFERENT button message,
 * matching how handleRepoChoice's per-message dedup Map is meant to be exercised.
 * Pass a fixed id to simulate the same button firing more than once.
 */
function tapCtx(data: string, repliedTo?: string, messageId?: number): FakeCtx {
  return fakeCtx("", {
    message: undefined,
    callbackQuery: {
      data,
      message: {
        message_id: messageId ?? Math.floor(Math.random() * 1000000) + 1,
        text: "Which repo?",
        reply_to_message: repliedTo ? { text: repliedTo } : undefined,
      },
    },
  });
}

describe("parseTaskArgs", () => {
  it("ASKS which repo when none is named, instead of silently choosing one", () => {
    // This used to default to FounderOS. `repo:` is the easiest part of this
    // command to forget, and forgetting it filed employer work against FounderOS
    // with no error — a wrong target that cost a real Antigravity run to notice.
    const parsed = parseTaskArgs("fix the flaky CSV export");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.kind).toBe("needs-repo");
    if (parsed.kind !== "needs-repo") return;
    expect(parsed.text).toBe("fix the flaky CSV export");
  });

  it("keeps a forgotten prefix out of the brief", () => {
    // "/task app fix the login" used to dispatch to FounderOS with the stray
    // word "app" still in the request handed to the executor.
    const parsed = parseTaskArgs("app fix the login button");
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.kind !== "needs-repo") return;
    expect(parsed.text).toBe("app fix the login button");
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
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.kind !== "needs-repo") return;
    expect(parsed.text).toBe("mention repo:hulda in the readme");
  });

  it("refuses an unknown repo hint and names the allowlist", () => {
    const parsed = parseTaskArgs("repo:linkedin-growth-engine-v2 do a thing");
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.kind === "needs-repo") return;
    expect(parsed.kind).toBe("refused");
    expect(parsed.message).toContain("linkedin-growth-engine-v2");
    expect(parsed.message).toContain("FounderOS");
    expect(parsed.message).toContain("House-of-Hulda-Website-frontend");
  });

  it("refuses an ambiguous hint instead of guessing", () => {
    // "o" matches both repo names. Picking the first would file the issue against a
    // repo the founder never named.
    const parsed = parseTaskArgs("repo:o do a thing");
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.kind === "needs-repo") return;
    expect(parsed.message).toMatch(/ambiguous|matches more than one/i);
    expect(parsed.message).toContain("FounderOS");
  });

  it("returns usage for empty input", () => {
    const empty = parseTaskArgs("   ");
    expect(empty.ok).toBe(false);
    if (empty.ok || empty.kind === "needs-repo") return;
    expect(empty.kind).toBe("needs-work");
    expect(empty.message).toContain("/task");
  });

  it("returns usage when a repo is named but no work is described", () => {
    const parsed = parseTaskArgs("repo:hulda");
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.kind === "needs-repo") return;
    expect(parsed.message).toContain("/task");
  });
});

describe("stripTaskCommand", () => {
  it("removes the command so it cannot end up inside the brief", () => {
    expect(stripTaskCommand("/task fix the login button")).toBe("fix the login button");
  });

  it("removes the @BotName suffix a group chat adds", () => {
    expect(stripTaskCommand("/task@FounderOSBot fix the login")).toBe("fix the login");
  });

  it("leaves an ordinary sentence alone", () => {
    expect(stripTaskCommand("fix the login button")).toBe("fix the login button");
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
    const { ctx } = fakeCtx("repo:hulda fix the flaky CSV export");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).toHaveBeenCalledTimes(1);
    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("dispatch_antigravity_task");
  });

  it("offers repo BUTTONS instead of a wall of syntax when none was named", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies, markups } = fakeCtx("fix the flaky CSV export");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies[0]).toContain("fix the flaky CSV export");
    const rows = (markups[0] as { inline_keyboard: { text: string }[][] }).inline_keyboard;
    expect(rows.flat().map((b) => b.text).join(" ")).toMatch(/Oplify app/);
  });

  it("attaches the question to his message, so the full request survives the tap", async () => {
    // The echo in the question is truncated for legibility. Recovering the brief
    // from it would silently shorten what the executor is asked to build.
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const replyOpts: Record<string, unknown>[] = [];
    const { ctx } = fakeCtx("fix the flaky CSV export", {
      reply: async (_t: string, opts: Record<string, unknown>) => void replyOpts.push(opts),
    });

    await handleTask(ctx, { runKernelText });

    expect(replyOpts[0]?.reply_parameters).toEqual({ message_id: 11 });
  });

  it("asks which repo first when there is nothing to build yet", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies, markups } = fakeCtx("");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies[0]).toMatch(/which repo/i);
    expect((markups[0] as { inline_keyboard: unknown[][] }).inline_keyboard.length).toBeGreaterThan(0);
  });

  it("refuses an off-allowlist repo WITHOUT spending a model call", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies } = fakeCtx("repo:someone-else/private-thing do a thing");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies.join("\n")).toContain("House-of-Hulda-Website-frontend");
  });

  it("answers something on empty input and spends nothing", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies } = fakeCtx("");

    await handleTask(ctx, { runKernelText });

    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies[0]?.trim()).toBeTruthy();
  });
});

// ── The button flows ─────────────────────────────────────────────────────────
//
// Nothing about the chosen repo lives in server memory between messages: the
// work travels on `reply_to_message`, and the repo travels on the prompt text.
// A restart mid-flow therefore loses nothing, and there is no per-chat map to
// expire or get wrong.

describe("handleRepoChoice", () => {
  it("dispatches to the tapped repo, using the untruncated original request", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = tapCtx("task:repo:House-of-Hulda-Website-frontend", "/task make the hero responsive");

    expect(await handleRepoChoice(ctx, { runKernelText })).toBe(true);
    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("pushkarverma3698/House-of-Hulda-Website-frontend");
    expect(instruction).toContain("make the hero responsive");
    expect(instruction).not.toContain("/task make");
  });

  it("asks what to build when the tap came from a bare /task", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx, replies, markups } = tapCtx("task:repo:oplify-messaging-app");

    expect(await handleRepoChoice(ctx, { runKernelText })).toBe(true);
    expect(runKernelText).not.toHaveBeenCalled();
    expect(replies[0]).toContain("OplifyMessage/oplify-messaging-app");
    expect(markups[0]).toMatchObject({ force_reply: true });
  });

  it("ignores a callback that is not a repo choice, so approve/reject still work", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    for (const data of ["approve", "reject"]) {
      expect(await handleRepoChoice(tapCtx(data).ctx, { runKernelText })).toBe(false);
    }
    expect(runKernelText).not.toHaveBeenCalled();
  });

  it("says so out loud when the payload no longer resolves, rather than doing nothing", async () => {
    // A button that silently does nothing is indistinguishable from a dead bot —
    // the same reasoning behind unknownCommandReply.
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const alerts: unknown[] = [];
    const { ctx } = tapCtx("task:repo:a-repo-that-was-removed");
    (ctx as unknown as { answerCallbackQuery: unknown }).answerCallbackQuery = async (o: unknown) =>
      void alerts.push(o);

    expect(await handleRepoChoice(ctx, { runKernelText })).toBe(true);
    expect(runKernelText).not.toHaveBeenCalled();
    expect(JSON.stringify(alerts)).toMatch(/no longer dispatchable/i);
  });

  it("does not double-dispatch when the same button fires twice before the repo lookup resolves", async () => {
    // TOCTOU regression (found in review, PR #731): the dedup check ran, THEN
    // `await registeredRepos(deps)`, THEN the mark — leaving a window where two
    // near-simultaneous callback deliveries for the same message (Telegram can
    // redeliver, or a fast double-tap) both pass the check before either marks it.
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const messageId = 12345;
    const makeCtx = () =>
      tapCtx("task:repo:House-of-Hulda-Website-frontend", "/task make the hero responsive", messageId).ctx;

    let resolveRepos!: (v: readonly string[]) => void;
    const slowRepos = new Promise<readonly string[]>((resolve) => {
      resolveRepos = resolve;
    });
    const deps = { runKernelText, listRegisteredRepos: () => slowRepos };

    const first = handleRepoChoice(makeCtx(), deps);
    const second = handleRepoChoice(makeCtx(), deps);
    resolveRepos([]);
    await Promise.all([first, second]);

    expect(runKernelText).toHaveBeenCalledTimes(1);
  });
});

describe("handleRepoReply", () => {
  const prompt = "📱 Oplify app — what should I build?\n\nRepo: OplifyMessage/oplify-messaging-app";

  it("dispatches a plain reply to the repo the prompt named", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("", {
      message: { message_id: 20, text: "make the login form keyboard-accessible", reply_to_message: { text: prompt } },
    });

    expect(await handleRepoReply(ctx, { runKernelText })).toBe(true);
    const [, instruction] = runKernelText.mock.calls[0] as [Context, string];
    expect(instruction).toContain("OplifyMessage/oplify-messaging-app");
    expect(instruction).toContain("keyboard-accessible");
  });

  it("passes an ordinary message through untouched", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("", { message: { message_id: 21, text: "what's my focus today?" } });

    expect(await handleRepoReply(ctx, { runKernelText })).toBe(false);
    expect(runKernelText).not.toHaveBeenCalled();
  });

  it("passes a reply to some OTHER message through untouched", async () => {
    const runKernelText = vi.fn().mockResolvedValue(undefined);
    const { ctx } = fakeCtx("", {
      message: { message_id: 22, text: "thanks", reply_to_message: { text: "Here is your brief." } },
    });

    expect(await handleRepoReply(ctx, { runKernelText })).toBe(false);
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
    if (parsed.ok || parsed.kind === "needs-repo") return;
    expect(parsed.message).toContain("turicks-pricing-api");
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
    const { ctx } = fakeCtx("repo:FounderOS fix the flaky CSV export");

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
  "../../../src/gateway/newproject-command.js"
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
