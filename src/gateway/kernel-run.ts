/**
 * FounderOS v3 — kernel run loop (Telegram).
 * ===========================================
 * One message → one kernel turn. Replaces the 1,210-line office-run.ts:
 * no regex guards, no double invokes, no checkpoint rewriting — the kernel's
 * typed contracts make those layers unnecessary. What remains is transport:
 * lock → halt/budget gates → invoke (timeout + budget callbacks) →
 * HITL card or reply. Failures arrive as typed FailureReports in the reply.
 */

import { type Context, InlineKeyboard } from "grammy";
import { Command, GraphRecursionError } from "@langchain/langgraph";
import { TENANT, DAILY_BUDGET_USD, OFFICE_TURN_TIMEOUT_MS, OFFICE_RECURSION_LIMIT } from "../core/config.js";
import { withTurnTimeout, TurnTimeoutError } from "./turn-timeout.js";
import { getKernel } from "./kernel-boot.js";
import { kernelReply, getPendingKernelApproval } from "../kernel/index.js";
import type { ApprovalRequest } from "../infra/hitl.js";
import { formatApprovalCard, safeHtml } from "./approval-card.js";
import { markdownToTelegramHtml, splitForTelegram } from "./format.js";
import { getPendingInterrupt, resolveInterrupt, getTodayCostUsd, logLlmCost } from "../db/queries.js";
import { BudgetExceededError, BudgetGuardCallback, createRunBudget, UNATTRIBUTED_AGENT, UNATTRIBUTED_STAGE, type AccruedCall } from "../infra/budget.js";
import { assertDailyBudgetAllowsRun, DailyBudgetExceededError } from "../infra/daily-budget.js";
import { readHalt, formatHaltNotice } from "../infra/halt.js";
import { startTurn } from "../infra/trace.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { kernelPromptHash } from "./prompt-version.js";
import { logger } from "../infra/logger.js";
import { isModelFallbackError } from "../agents/model.js";
import { enqueueTurnAutoRetry } from "./auto-retry.js";
import { recordFailedTurnInHistory, type FoldableKernel } from "./failed-turn-fold.js";
import { streamKernelTurn, progressLabelFor } from "./kernel-progress.js";

// Progress streaming lives in ./kernel-progress.ts; re-exported so the gateway's
// public surface (and its tests) keep addressing kernel-run.
export { progressLabelFor };

const log = logger.child({ module: "kernel-run" });

/** Only re-post HITL cards paused within this window (crash recovery). */
export const HITL_RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// ── Per-chat turn serialization ────────────────────────────────────────────────

const chatTurnChains = new Map<string, Promise<void>>();

export async function withChatTurnLock<T>(chatId: string | number, fn: () => Promise<T>): Promise<T> {
  const key = String(chatId);
  const tail = chatTurnChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  chatTurnChains.set(key, tail.then(() => slot));
  await tail;
  try {
    return await fn();
  } finally {
    release();
    if (chatTurnChains.get(key) === slot) chatTurnChains.delete(key);
  }
}

export function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

/**
 * Persist one LLM call to ai_call_costs. The daily budget cap
 * (assertDailyBudgetAllowsRun → getTodayCostUsd) and the cost ledger
 * (pnpm proof:costs, /budget) read this table — without this sink both see $0.
 * Fire-and-forget: a DB blip must never break a founder turn.
 * `agent` = the actor, `tier` = the kernel stage (src/db/schema.ts aiCallCosts).
 */
export function kernelCostSink(call: AccruedCall): void {
  void logLlmCost({
    tenant_id: TENANT,
    agent: call.attribution?.agent ?? UNATTRIBUTED_AGENT,
    tier: call.attribution?.stage ?? UNATTRIBUTED_STAGE,
    model: call.model,
    tokens_in: call.inputTokens,
    tokens_out: call.outputTokens,
    cost_usd: call.usd.toFixed(6),
  }).catch((err) => log.warn({ err: String(err) }, "ai_call_costs write failed")); // allow-failopen: cost row is telemetry; the turn must not die on a DB blip
}

function makeBudgetCallback(): BudgetGuardCallback {
  return new BudgetGuardCallback(createRunBudget(), process.env["AGENT_MODEL"] ?? "", kernelCostSink);
}

// ── Reply / card senders ───────────────────────────────────────────────────────

async function sendReply(ctx: Context, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  for (const chunk of splitForTelegram(html)) {
    await ctx.reply(chunk, { parse_mode: "HTML" }).catch(async () => {
      // Telegram rejected the HTML (edge-case entities) — send plain, never drop.
      await ctx.reply(text.slice(0, 4000));
    });
  }
}

async function sendApprovalCard(ctx: Context, approval: ApprovalRequest): Promise<void> {
  const card = formatApprovalCard(approval);
  await ctx.reply(card.html, { parse_mode: "HTML", reply_markup: card.keyboard });
}

// ── One text turn ──────────────────────────────────────────────────────────────

export async function runKernelText(ctx: Context, text: string): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  await withChatTurnLock(chatId, async () => {
    const trace = startTurn({ chatId: String(chatId), kind: "message", promptHash: kernelPromptHash() });
    let foldCtx: { kernel: FoldableKernel; config: unknown } | undefined;
    try {
      const halt = await readHalt();
      if (halt) {
        await ctx.reply(formatHaltNotice(halt), { parse_mode: "HTML" });
        return;
      }
      await assertDailyBudgetAllowsRun(
        () => getTodayCostUsd(TENANT),
        DAILY_BUDGET_USD,
        (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped — fail-open"),
      );

      const kernel = await getKernel();
      const config = {
        configurable: { thread_id: threadIdFor(chatId) },
        recursionLimit: OFFICE_RECURSION_LIMIT,
        callbacks: [makeBudgetCallback(), new TraceCallback(trace)],
      };
      foldCtx = { kernel: kernel as unknown as FoldableKernel, config };
      trace.event("turn.in", { textPreview: text.slice(0, 120) });

      // On deadline the run is ABORTED, not abandoned — the signal goes only to
      // stream() so the post-timeout fold/getState still work on a clean config.
      const abort = new AbortController();
      const res = await withTurnTimeout(
        streamKernelTurn(
          ctx,
          trace,
          kernel.stream(
            {
              turn: {
                id: trace.turnId,
                chat_id: String(chatId),
                received_at: new Date().toISOString(),
                raw_input: text,
              },
            },
            { ...config, streamMode: "values", signal: abort.signal },
          ) as Promise<AsyncIterable<unknown>>,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.invoke",
        () => abort.abort(),
      );

      const approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title });
        await sendApprovalCard(ctx, approval);
        return;
      }

      const reply = kernelReply(res as never);
      trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
      await sendReply(ctx, reply);
    } catch (err) {
      trace.event("turn.error", { message: err instanceof Error ? err.message.slice(0, 400) : String(err) });
      if (foldCtx) await recordFailedTurnInHistory(foldCtx.kernel, foldCtx.config, err);
      // A live text turn can be replayed verbatim, so provider exhaustion auto-retries.
      await replyForError(ctx, err, { chatId: String(chatId), text, turnId: trace.turnId });
    }
  });
}

// ── Resume after an approval decision ─────────────────────────────────────────

export async function resumeKernel(ctx: Context, decision: "approved" | "rejected"): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  await withChatTurnLock(chatId, async () => {
    const threadId = threadIdFor(chatId);
    const trace = startTurn({ chatId: String(chatId), kind: "resume", promptHash: kernelPromptHash() });
    let foldCtx: { kernel: FoldableKernel; config: unknown } | undefined;
    try {
      const pending = await getPendingInterrupt(threadId);
      if (pending) {
        await resolveInterrupt(pending.interrupt_id, decision);
      }
      const kernel = await getKernel();
      const config = {
        configurable: { thread_id: threadId },
        recursionLimit: OFFICE_RECURSION_LIMIT,
        callbacks: [makeBudgetCallback(), new TraceCallback(trace)],
      };
      foldCtx = { kernel: kernel as unknown as FoldableKernel, config };
      trace.event("hitl.resume", { decision });

      const abort = new AbortController();
      const res = await withTurnTimeout(
        streamKernelTurn(
          ctx,
          trace,
          kernel.stream(new Command({ resume: decision }), {
            ...config,
            streamMode: "values",
            signal: abort.signal,
          }) as Promise<AsyncIterable<unknown>>,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.resume",
        () => abort.abort(),
      );

      // A multi-step plan can pause again on the NEXT gated step.
      const approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title });
        await sendApprovalCard(ctx, approval);
        return;
      }

      // interrupt() re-execution re-inserts a pending hitl_approvals row
      // (hitlGate cannot tell a resume re-run from a fresh gate). The graph
      // checkpoint is the source of truth: it is NOT paused here, so any
      // still-pending row for this thread is that artifact — resolve it with
      // the founder's decision so no phantom card can ever be restored.
      const orphan = await getPendingInterrupt(threadId);
      if (orphan) {
        await resolveInterrupt(orphan.interrupt_id, decision);
      }

      const reply = kernelReply(res as never);
      trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
      await sendReply(ctx, reply);
    } catch (err) {
      trace.event("turn.error", { message: err instanceof Error ? err.message.slice(0, 400) : String(err) });
      if (foldCtx) await recordFailedTurnInHistory(foldCtx.kernel, foldCtx.config, err);
      await replyForError(ctx, err);
    }
  });
}

// ── Crash recovery ─────────────────────────────────────────────────────────────

/** Re-post a recent pending approval card after a restart (state survives in Postgres). */
export async function restorePendingApproval(
  chatId: string,
  send: (text: string, keyboard: InlineKeyboard) => Promise<void>,
): Promise<boolean> {
  const pending = await getPendingInterrupt(threadIdFor(chatId));
  if (!pending?.created_at) return false;
  if (Date.now() - new Date(pending.created_at).getTime() > HITL_RESTORE_MAX_AGE_MS) return false;
  const payload = JSON.parse(pending.callback_data ?? "{}") as Omit<ApprovalRequest, "kind">;
  const card = formatApprovalCard({ kind: "approval", ...payload }, { afterRestart: true });
  await send(card.html, card.keyboard);
  return true;
}

// ── Typed error replies (fail loud; the thread is NEVER wiped) ────────────────

/** `retry` (a live text turn, replayable verbatim) lets provider exhaustion queue ONE auto-retry; a resume omits it and keeps the manual path. */
async function replyForError(
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
  await ctx.reply(`❌ <b>Error</b>\n<code>${safeHtml(msg.slice(0, 1000))}</code>`, { parse_mode: "HTML" });
}
