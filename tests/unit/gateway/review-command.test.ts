/**
 * Unit tests for /review — show or switch the automatic PR review (pr-brain).
 *
 * pr-brain is a cron job on the VPS that stops while ~/.claude/pr-brain.off exists. The bot runs as
 * the same user, so /review writes or removes that file. What the founder is told must be what the
 * file now says, so every switch is read back, and the models shown come from the live crontab line.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";
import { OWNER_ONLY_COMMANDS } from "../../../src/gateway/chat-access.js";
import { needsConfirmation } from "../../../src/gateway/command-catalog.js";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";

const { handleReview, readReviewSetup } = await import("../../../src/gateway/review-command.js");

const LIVE_CRONTAB = [
  "# pr-brain — asynchronous adversarial PR gate",
  "# Disable with: touch $HOME/.claude/pr-brain.off",
  '*/20 * * * * PATH=/usr/local/bin:/usr/bin:/bin PR_BRAIN_MERGE=0 PR_BRAIN_MODELS="claude-sonnet-5-5-medium gemini-3.1-pro-high" PR_BRAIN_ROOT=/opt/review $HOME/bin/pr-brain >/dev/null 2>>$HOME/.claude/pr-brain.log',
  "*/15 * * * * PATH=/usr/local/bin:/usr/bin:/bin AGENT_DISPATCH_ENV_FILE=/opt/founderos/.env $HOME/bin/agent-dispatch >/dev/null",
].join("\n");

/** The off-switch file in memory. `failWrite` throws; `dropWrite` accepts the call and changes nothing. */
function fakeSwitch(off: boolean, mode: "ok" | "failWrite" | "dropWrite" = "ok", crontab: string | Error = LIVE_CRONTAB) {
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
      crontab: () => {
        if (crontab instanceof Error) throw crontab;
        return crontab;
      },
      engine: () => "agy" as const,
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

describe("readReviewSetup — the models come from the live cron lines", () => {
  it("reads the reviewer list and the merge flag off the pr-brain line, and the script defaults for the writer", () => {
    expect(readReviewSetup(LIVE_CRONTAB)).toEqual({
      reviewers: ["claude-sonnet-5-5-medium", "gemini-3.1-pro-high"],
      merges: false,
      agyModel: "gemini-3.6-flash-medium",
      claudeModel: "sonnet",
    });
  });

  it("uses the script defaults when the cron lines set nothing, and the dispatcher's model overrides", () => {
    const tab = "*/20 * * * * $HOME/bin/pr-brain\n* * * * * AGENT_DISPATCH_MODEL=gemini-3.1-pro-high AGENT_DISPATCH_CLAUDE_MODEL=opus $HOME/bin/agent-dispatch --kicked";
    expect(readReviewSetup(tab)).toEqual({
      reviewers: ["claude-sonnet-5-5-medium", "gemini-3.1-pro-high"],
      merges: true,
      agyModel: "gemini-3.1-pro-high",
      claudeModel: "opus",
    });
  });

  it("ignores a commented-out pr-brain line", () => {
    const tab = '# */20 * * * * PR_BRAIN_MODELS="old-model" $HOME/bin/pr-brain\n*/20 * * * * PR_BRAIN_MODELS=new-model $HOME/bin/pr-brain';
    expect(readReviewSetup(tab).reviewers).toEqual(["new-model"]);
  });

  it("reads PR_BRAIN_MODEL when PR_BRAIN_MODELS is absent, as the script does", () => {
    expect(readReviewSetup("*/20 * * * * PR_BRAIN_MODEL=gemini-3.1-pro-high $HOME/bin/pr-brain").reviewers).toEqual(["gemini-3.1-pro-high"]);
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
    expect(r).toContain("Writer for /task: Google Antigravity on gemini-3.6-flash-medium");
    expect(r).toContain("/review off");
    expect(f.state.writes).toEqual([]);
  });

  it("says it is off, and how to turn it on", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(true).deps);
    expect(replies[0]).toContain("Automatic PR review is OFF");
    expect(replies[0]).toContain("/review on");
  });

  it("still answers on/off when the crontab cannot be read, and says why the models are missing", async () => {
    const { ctx, replies } = fakeCtx("");
    await handleReview(ctx, fakeSwitch(false, "ok", new Error("crontab: command not found")).deps);
    expect(replies[0]).toContain("Automatic PR review is ON");
    expect(replies[0]).toContain("Could not read the models from the crontab: crontab: command not found");
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
