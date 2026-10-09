/**
 * Unit tests for /review — show or switch the automatic PR review (pr-brain).
 *
 * pr-brain is a cron job on the VPS that stops while ~/.claude/pr-brain.off exists. The bot runs as
 * the same user, so /review writes or removes that file. What the founder is told must be what the
 * file now says, so every switch is read back.
 *
 * The models come from files the daemons write each run (~/.claude/pr-brain.effective and
 * agent-dispatch.effective), not from `crontab -l`: the bot runs under NoNewPrivileges=true, where
 * crontab is denied ("Permission denied"), so on 2026-10-04 /review said ON and could not show a model.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";
import { OWNER_ONLY_COMMANDS } from "../../../src/gateway/chat-access.js";
import { needsConfirmation } from "../../../src/gateway/command-catalog.js";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";
import { readReviewSetup } from "../../../src/infra/daemon-settings.js";

const { handleReview } = await import("../../../src/gateway/review-command.js");

const WRITTEN = 1791118800; // epoch seconds the daemons last wrote their files
const FIVE_MIN_LATER = (WRITTEN + 300) * 1000;

const PR_BRAIN_FILE = [`written=${WRITTEN}`, "engine=agy", "reviewers=claude-sonnet-5-5-medium gemini-3.1-pro-high", "merge=0"].join("\n");
const DISPATCH_FILE = [`written=${WRITTEN}`, "agy_model=gemini-3.8-flash-medium", "claude_model=sonnet"].join("\n");

type Files = { "pr-brain"?: string | null | Error; "agent-dispatch"?: string | null | Error };
const LIVE_FILES: Files = { "pr-brain": PR_BRAIN_FILE, "agent-dispatch": DISPATCH_FILE };

/** The off-switch file in memory. `failWrite` throws; `dropWrite` accepts the call and changes nothing. */
function fakeSwitch(
  off: boolean,
  mode: "ok" | "failWrite" | "dropWrite" = "ok",
  files: Files = LIVE_FILES,
  opts: { now?: number; engine?: "agy" | "claude" } = {},
) {
  const state = { off, writes: [] as boolean[] };
  return {
    state,
    deps: {
      isOff: () => state.off,
      setOff: (value: boolean) => {
        state.writes.push(value);
        if (mode === "failWrite") throw new Error("EACCES: permission denied");
        if (mode === "ok") state.off = value;
      },
      effective: (name: "pr-brain" | "agent-dispatch") => {
        const f = files[name] ?? null;
        if (f instanceof Error) throw f;
        return f;
      },
      now: () => opts.now ?? FIVE_MIN_LATER,
      engine: () => opts.engine ?? ("agy" as const),
    },
  };
}

function fakeCtx(match: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    match,
    message: { message_id: 7, text: `/review ${match}` },
    reply: async (text: string) => void replies.push(text),
  } as unknown as Context;
  return { ctx, replies };
}

describe("readReviewSetup — the models are what the daemons reported, not a guess", () => {
  it("reads the reviewer list, the merge flag and both writer models, and when each daemon last reported", () => {
    expect(readReviewSetup(PR_BRAIN_FILE, DISPATCH_FILE)).toEqual({
      reviewers: ["claude-sonnet-5-5-medium", "gemini-3.1-pro-high"],
      merges: false,
      agyModel: "gemini-3.8-flash-medium",
      claudeModel: "sonnet",
      reviewerReportedAt: WRITTEN * 1000,
      writerReportedAt: WRITTEN * 1000,
    });
  });

  it("merges unless the daemon reports merge=0", () => {
    expect(readReviewSetup("written=1\nreviewers=a\nmerge=1", null).merges).toBe(true);
    expect(readReviewSetup("written=1\nreviewers=a", null).merges).toBe(true);
  });

  it("splits a comma- or space-separated model list, as the script does", () => {
    expect(readReviewSetup("written=1\nreviewers=a,b  c", null).reviewers).toEqual(["a", "b", "c"]);
  });

  it("knows nothing when a file is missing, empty or not a report, rather than inventing defaults", () => {
    for (const bad of [null, "", "garbage without keys", "written=1\nreviewers="]) {
      const r = readReviewSetup(bad, bad);
      expect(r.reviewers).toBeNull();
      expect(r.merges).toBeNull();
      expect(r.agyModel).toBeNull();
      expect(r.claudeModel).toBeNull();
    }
  });

  it("ignores a line it does not understand and a value with no key", () => {
    expect(readReviewSetup("written=1\n# note\n=x\nreviewers=only-this", null).reviewers).toEqual(["only-this"]);
  });
});

describe("/review with no argument", () => {
  it("says it is on, names the reviewers in order, the merge setting and the writer, and how to switch", async () => {
    const f = fakeSwitch(false);
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, f.deps);

    expect(replies).toHaveLength(1);
    const r = replies[0]!;
    expect(r).toContain("Automatic PR review is ON");
    expect(r).toContain("Reviewer: claude-sonnet-5-5-medium, then gemini-3.1-pro-high");
    expect(r).toContain("never merges: you merge");
    expect(r).toContain("Writer for /task: Google Antigravity on gemini-3.8-flash-medium");
    expect(r).toContain("/review off");
    expect(f.state.writes).toEqual([]);
  });

  it("says it is off, and how to turn it on", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(true).deps);
    expect(replies[0]).toContain("Automatic PR review is OFF");
    expect(replies[0]).toContain("/review on");
  });

  it("shows the claude writer model when the engine is claude", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(false, "ok", LIVE_FILES, { engine: "claude" }).deps);
    expect(replies[0]).toContain("Writer for /task: Claude Code on sonnet");
  });

  it("says nothing about how old the report is while it is fresh (no noise when nothing is wrong)", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(false).deps);
    expect(replies[0]).not.toMatch(/reported|ago/i);
  });

  it("says how old the report is once it is stale, because a stopped cron would otherwise show old models as current", async () => {
    const { ctx, replies } = fakeCtx("");
    const fiveHoursLater = (WRITTEN + 5 * 3600) * 1000;
    await handleReview(ctx, fakeSwitch(false, "ok", LIVE_FILES, { now: fiveHoursLater }).deps);
    expect(replies[0]).toContain("Reviewer: claude-sonnet-5-5-medium, then gemini-3.1-pro-high (last reported 5 h ago)");
    expect(replies[0]).toContain("(last reported 5 h ago)");
  });

  it("still answers on/off when the daemons have not reported yet, and says what to expect instead of an error", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(false, "ok", {}).deps);
    expect(replies[0]).toContain("Automatic PR review is ON");
    expect(replies[0]).toContain("Reviewer models: not reported yet");
    expect(replies[0]).toContain("Writer model: not reported yet");
    expect(replies[0]).not.toMatch(/crontab: |permission denied/i);
  });

  it("names the file and the reason when a report cannot be read, and still shows the other one", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(false, "ok", { "pr-brain": new Error("EACCES: permission denied"), "agent-dispatch": DISPATCH_FILE }).deps);
    expect(replies[0]).toContain("Automatic PR review is ON");
    expect(replies[0]).toContain("Could not read ~/.claude/pr-brain.effective: EACCES: permission denied");
    expect(replies[0]).toContain("Writer for /task: Google Antigravity on gemini-3.8-flash-medium");
  });
});

describe("/review reads the real files the daemons write (the path the bot takes in production)", () => {
  it("shows the reviewers from ~/.claude/pr-brain.effective under a home with no crontab at all", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "review-home-"));
    const oldHome = process.env["HOME"];
    try {
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "pr-brain.effective"), `written=${Math.floor(Date.now() / 1000)}\nreviewers=model-a model-b\nmerge=1\n`);
      process.env["HOME"] = home;
      const { ctx, replies } = fakeCtx("");
      await handleReview(ctx);
      expect(replies[0]).toContain("Automatic PR review is ON");
      expect(replies[0]).toContain("Reviewer: model-a, then model-b");
      expect(replies[0]).toContain("Writer model: not reported yet"); // agent-dispatch.effective was not written
    } finally {
      if (oldHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("/review on | off", () => {
  it("off writes the switch, reads it back and confirms; a review already running finishes", async () => {
    const f = fakeSwitch(false);
    const { ctx, replies } = fakeCtx("off");
    await handleReview(ctx, f.deps);
    expect(f.state.writes).toEqual([true]);
    expect(replies[0]).toContain("Automatic PR review is now OFF");
    expect(replies[0]).toMatch(/already running finishes/);
  });

  it("on removes the switch and confirms", async () => {
    const f = fakeSwitch(true);
    const { ctx, replies } = fakeCtx("ON");
    await handleReview(ctx, f.deps);
    expect(f.state.writes).toEqual([false]);
    expect(replies[0]).toContain("Automatic PR review is now ON");
  });

  it("reports a write that threw, with the reason, and the state it is really in", async () => {
    const { ctx, replies } = fakeCtx("off");
    await handleReview(ctx, fakeSwitch(false, "failWrite").deps);
    expect(replies[0]).toContain("Could not switch it: EACCES: permission denied. It is still ON.");
  });

  it("reports a write that returned but did not take, instead of trusting it", async () => {
    const { ctx, replies } = fakeCtx("off");
    await handleReview(ctx, fakeSwitch(false, "dropWrite").deps);
    expect(replies[0]).toContain("It is still ON.");
    expect(replies[0]).not.toContain("now OFF");
  });

  it("refuses any other word and changes nothing", async () => {
    const f = fakeSwitch(false);
    const { ctx, replies } = fakeCtx("pause");
    await handleReview(ctx, f.deps);
    expect(f.state.writes).toEqual([]);
    expect(replies[0]).toContain('"pause" is not a setting. Use /review on or /review off.');
  });
});

describe("/review is wired as a system-wide switch", () => {
  it("is in the menu, owner-only, and asks for a tap when plain words try to switch it", () => {
    expect(COMMAND_MENU.some((e) => e.command === "review")).toBe(true);
    expect(OWNER_ONLY_COMMANDS.has("review")).toBe(true);
    expect(needsConfirmation("review", "")).toBe(false);
    expect(needsConfirmation("review", "off")).toBe(true);
  });
});
