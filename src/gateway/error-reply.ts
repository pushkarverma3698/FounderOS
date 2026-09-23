import type { Context } from "grammy";
import { GraphRecursionError } from "@langchain/langgraph";
import { TurnTimeoutError } from "./turn-timeout.js";
import { safeHtml } from "./approval-card.js";
import { BudgetExceededError } from "../infra/budget.js";
import { DailyBudgetExceededError } from "../infra/daily-budget.js";
import { logger } from "../infra/logger.js";
import { isModelFallbackError } from "../agents/model.js";
import { enqueueTurnAutoRetry } from "./auto-retry.js";

const log = logger.child({ module: "error-reply" });

/** Strip file paths, stack frames, and SQL from error messages shown to the founder. */
function sanitizeErrorForFounder(msg: string): string {
  let clean = msg
    // Strip stack frames ("    at Foo (/path/to/file.ts:123:45)")
    .replace(/\n\s+at\s+.+/g, "")
    // Strip Node/internal paths
    .replace(/\/(?:Users|home|var|opt|app)[^\s)]+/g, "[path]")
    // Strip SQL fragments
    .replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN|INTO)\b[^.!?\n]*/gi, "[query]")
    .trim();
  // Cap at first meaningful sentence if the raw error is a wall of text.
  if (clean.length > 300) {
    const firstSentence = clean.match(/^[^.!?\n]+[.!?]/)?.[0];
    clean = firstSentence ?? clean.slice(0, 300);
  }
  return clean;
}

/** `retry` (a live text turn, replayable verbatim) lets provider exhaustion queue ONE auto-retry; a resume omits it and keeps the manual path. */
export async function replyForError(
  ctx: Context,
  err: unknown,
  retry?: { chatId: string; text: string; turnId: string },
): Promise<void> {
  if (err instanceof BudgetExceededError) {
    await ctx.reply(
      `💰 <b>Run stopped — budget limit reached</b>\n<code>${safeHtml(err.reason)}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (err instanceof DailyBudgetExceededError) {
    await ctx.reply(
      `🛑 <b>Daily budget cap reached</b>\n<code>${safeHtml(err.reason)}</code>\nCheck spend: /budget`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (err instanceof TurnTimeoutError) {
    await ctx.reply(
      `⏱️ <b>That took too long and I stopped it</b> (over ${Math.round(err.ms / 1000)}s). ` +
        `The mission state is saved — try again or break the task down.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (err instanceof GraphRecursionError) {
    // With the kernel's bounded steps this should be unreachable; if it fires it is a bug — say so.
    await ctx.reply(
      `🔁 <b>Hit the graph recursion limit</b> — this should not happen in v3; please report. State is preserved.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (isModelFallbackError(err)) {
    // Provider outage/rate-limit after the whole fallback chain — a raw SDK
    // stack here reads like a system bug to the founder (2026-07-12 68eae59d).
    if (retry && (await enqueueTurnAutoRetry(retry.chatId, retry.text, retry.turnId))) {
      // Auto-retry queued (2026-07-13 audit) — the founder does nothing.
      await ctx.reply(
        `🤖 <b>The AI provider is rate-limited right now</b> — nothing is broken on our side. ` +
          `I'll retry automatically in ~3 minutes; you don't need to do anything.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    // No replayable input (a resume) or the queue write failed — manual fallback.
    await ctx.reply(
      `🤖 <b>The AI provider is overloaded or rate-limited right now</b> — nothing is broken on our side. ` +
        `Wait a minute and send "try again"; I remember what you asked.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  log.error({ err: err instanceof Error ? (err.stack ?? msg) : msg }, "Kernel run failed");
  const displayMsg = sanitizeErrorForFounder(msg);
  await ctx.reply(
    `❌ <b>Error</b>\n<code>${safeHtml(displayMsg)}</code>\n\nTry again, or /reset if this keeps happening.`,
    { parse_mode: "HTML" },
  );
}
