/**
 * FounderOS — goals: the one line at /resume
 * ==========================================
 * While FounderOS is halted the 09:00 standup does not run (src/goals/standup.ts records the day in
 * src/goals/skipped.ts). At /resume the founder is told which days, once. This is its own small file so
 * commands.ts, which every command test imports, pulls in nothing but the ledger.
 */

import type { Context } from "grammy";
import { formatSkippedLine, createFileSkipLedger, type SkipLedger } from "../goals/skipped.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "goal-resume" });

/** "standup skipped on 30 Sep, 1 Oct", once, after /resume lifted a halt. Never fails /resume. */
export async function replySkippedStandups(ctx: Context, ledger: SkipLedger = createFileSkipLedger()): Promise<void> {
  try {
    const line = formatSkippedLine(await ledger.take());
    if (line !== null) await ctx.reply(line);
  } catch (err) {
    // allow-failopen: the note is advice. /resume has already lifted the halt and said so, and a ledger or send blip must not turn that into a failure.
    log.warn({ component: "goal-resume", error: err instanceof Error ? err.message.slice(0, 200) : "unknown error" }, "Could not report the skipped standups at /resume");
  }
}
