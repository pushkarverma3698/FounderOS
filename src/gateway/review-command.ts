/**
 * FounderOS — /review
 * ===================
 * Shows or switches the automatic PR review (pr-brain, deploy/vps-daemons/pr-brain):
 *
 *   /review        → on or off, the reviewer models in order, whether it merges, and who writes the code
 *   /review off    → stop reviewing from the next cron tick
 *   /review on     → start again
 *
 * pr-brain does nothing while ~/.claude/pr-brain.off exists, and the bot runs as the same founderos user,
 * so the switch is that file. Like /engine, a switch is confirmed by reading the file back, never by
 * trusting that the write returned.
 *
 * The models are read from the live crontab lines, because that is where they are set. When a line sets
 * nothing, the defaults below are the scripts' own (pr-brain REVIEW_MODELS, deploy/lib/agy-run.sh,
 * deploy/lib/claude-run.sh); change them together.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "grammy";
import { engineDisplay, readDefaultEngine, type Engine } from "../tools/coding-engine.js";

const DEFAULT_REVIEWERS = "claude-sonnet-5-5-medium gemini-3.1-pro-high";
const DEFAULT_AGY_MODEL = "gemini-3.6-flash-medium";
const DEFAULT_CLAUDE_MODEL = "sonnet";

export interface ReviewSetup {
  readonly reviewers: readonly string[];
  readonly merges: boolean;
  readonly agyModel: string;
  readonly claudeModel: string;
}

export interface ReviewCommandDeps {
  readonly isOff: () => boolean;
  readonly setOff: (off: boolean) => void;
  readonly crontab: () => string;
  readonly engine: () => Engine;
}

export function reviewOffFile(): string {
  return join(homedir(), ".claude", "pr-brain.off");
}

const REAL_DEPS: ReviewCommandDeps = {
  isOff: () => existsSync(reviewOffFile()),
  setOff: (off) => {
    const file = reviewOffFile();
    if (!off) return rmSync(file, { force: true });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `switched off from Telegram /review at ${new Date().toISOString()}\n`);
  },
  crontab: () => execFileSync("crontab", ["-l"], { encoding: "utf8", timeout: 5_000 }),
  engine: () => readDefaultEngine(),
};

/** KEY=value assignments on the first uncommented crontab line that runs `bin/<script>`. */
function cronEnv(crontab: string, script: string): Map<string, string> {
  const line = crontab.split("\n").find((l) => !l.trimStart().startsWith("#") && new RegExp(`bin/${script}(\\s|$)`).test(l));
  const env = new Map<string, string>();
  for (const m of (line ?? "").matchAll(/(?:^|\s)([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/g)) {
    env.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return env;
}

export function readReviewSetup(crontab: string): ReviewSetup {
  const brain = cronEnv(crontab, "pr-brain");
  const dispatch = cronEnv(crontab, "agent-dispatch");
  const reviewers = brain.get("PR_BRAIN_MODELS") || brain.get("PR_BRAIN_MODEL") || DEFAULT_REVIEWERS;
  return {
    reviewers: reviewers.split(/[\s,]+/).filter(Boolean),
    merges: (brain.get("PR_BRAIN_MERGE") ?? "1") !== "0",
    agyModel: dispatch.get("AGENT_DISPATCH_MODEL") || DEFAULT_AGY_MODEL,
    claudeModel: dispatch.get("AGENT_DISPATCH_CLAUDE_MODEL") || DEFAULT_CLAUDE_MODEL,
  };
}

const state = (off: boolean): string => (off ? "OFF" : "ON");

function describeSetup(deps: ReviewCommandDeps): string {
  let setup: ReviewSetup;
  try {
    setup = readReviewSetup(deps.crontab());
  } catch (err) {
    // Not swallowed: the reason is printed, and on/off is still answered from the file.
    return `Could not read the models from the crontab: ${err instanceof Error ? err.message : String(err)}`;
  }
  const engine = deps.engine();
  const writerModel = engine === "claude" ? setup.claudeModel : setup.agyModel;
  return [
    `Reviewer: ${setup.reviewers.join(", then ")}`,
    setup.merges ? "A PR it clears is merged automatically." : "It reviews and clears PRs but never merges: you merge.",
    `Writer for /task: ${engineDisplay(engine)} on ${writerModel} (/engine switches it)`,
    "Models are set on the pr-brain and agent-dispatch lines of the founderos crontab on the VPS.",
  ].join("\n");
}

export async function handleReview(ctx: Context, deps: ReviewCommandDeps = REAL_DEPS): Promise<void> {
  const arg = (ctx.match?.toString() ?? "").trim().toLowerCase();

  if (!arg) {
    const off = deps.isOff();
    const flip = off ? "Turn it on with /review on." : "Turn it off with /review off.";
    await ctx.reply(`Automatic PR review is ${state(off)}. ${flip}\n${describeSetup(deps)}`);
    return;
  }

  if (arg !== "on" && arg !== "off") {
    await ctx.reply(`"${arg}" is not a setting. Use /review on or /review off.`);
    return;
  }

  const wantOff = arg === "off";
  let failure: string | undefined;
  try {
    deps.setOff(wantOff);
  } catch (err) {
    // Not swallowed: the reason goes into the reply below, and the state is read back, not assumed.
    failure = err instanceof Error ? err.message : String(err);
  }

  const off = deps.isOff();
  if (!failure && off !== wantOff) failure = "the switch file did not change after the write";
  if (failure) {
    await ctx.reply(`Could not switch it: ${failure}. It is still ${state(off)}.`);
    return;
  }

  await ctx.reply(
    off
      ? "Automatic PR review is now OFF from its next cron run. A review already running finishes. " +
          "Agent PRs stay drafts until you review them or send /review on."
      : "Automatic PR review is now ON. Its next cron run picks up the open agent PRs.",
  );
}
