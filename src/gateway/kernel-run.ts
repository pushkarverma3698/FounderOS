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
import { BudgetExceededError, enforceRunBudget, UNATTRIBUTED_AGENT, UNATTRIBUTED_STAGE, type AccruedCall } from "../infra/budget.js";
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
import { cleanupResumeArtifact } from "./resume-artifact-cleanup.js";
import { replyForError } from "./error-reply.js";

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
  const next = tail.then(() => slot);
  chatTurnChains.set(key, next);
  await tail;
  try {
    return await fn();
  } finally {
    release();
    if (chatTurnChains.get(key) === next) chatTurnChains.delete(key);
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

/**
 * The run's spend cap, as an AbortSignal.
 *
 * NOT just a callback. Until 2026-09-08 the cap was enforced by throwing from
 * `BudgetGuardCallback.handleLLMEnd`, and LangChain catches whatever a callback
 * handler throws — so `catch (err instanceof BudgetExceededError)` below could
 * never fire, and a real turn (7dd021d8, 2026-09-07) breached the 100k-token
 * cap five times and kept calling tools after each one. Enforcement now rides
 * the same signal the turn timeout uses, which the framework does honour.
 */
function makeRunBudget(): ReturnType<typeof enforceRunBudget> {
  return enforceRunBudget(process.env["AGENT_MODEL"] ?? "", kernelCostSink);
}

/**
 * What actually stopped this turn.
 *
 * A budget abort surfaces from LangChain as a generic AbortError, which reads
 * to the founder as an unexplained crash. A turn timeout keeps its own identity
 * — it is the more specific fact, and reporting a deadline as a spend cap would
 * send him to /budget for a problem that is not there.
 */
function failureFor(err: unknown, budget: ReturnType<typeof enforceRunBudget>): unknown {
  if (err instanceof TurnTimeoutError) return err;
  return budget.breachError() ?? err;
}

// ── Reply / card senders ───────────────────────────────────────────────────────

async function sendReply(ctx: Context, text: string): Promise<void> {
  const html = markdownToTelegramHtml(text);
  for (const chunk of splitForTelegram(html)) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch {
      // Telegram rejected the HTML (edge-case entities) — send this chunk plain, never drop or truncate.
      const plain = chunk.replace(/<[^>]*>/g, "");
      for (const sub of splitForTelegram(plain)) {
        await ctx.reply(sub);
      }
    }
  }
}

async function sendApprovalCard(ctx: Context, approval: ApprovalRequest, nonce?: string): Promise<void> {
  const card = formatApprovalCard(approval, { nonce });
  await ctx.reply(card.html, { parse_mode: "HTML", reply_markup: card.keyboard });
}

// ── One text turn ──────────────────────────────────────────────────────────────

/**
 * `profileId` names whose row this turn is about — set by jobhunt-commands.ts
 * whenever the instruction text was composed FOR a specific candidate's row
 * (draft/ask). It rides in `configurable.profile_id`, the same per-invocation
 * channel `thread_id` already uses, and lets the jobhunt worker's system
 * prompt (kernel-boot.ts's `promptForProfile`) name the right candidate for
 * THIS turn without rebuilding the kernel, which is compiled once and reused
 * forever. Omitted (the general free-text path) means "no override" — the
 * worker keeps the default-profile prompt it always had.
 */
export async function runKernelText(ctx: Context, text: string, profileId?: string): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  // UX: Let the founder know the system heard him if another turn is already running.
  if (chatTurnChains.has(String(chatId))) {
    await ctx.reply("⏳ Got it — finishing the current request first.").catch(() => undefined); // allow-failopen: queue ack is cosmetic
  }
  await withChatTurnLock(chatId, async () => {
    const trace = startTurn({ chatId: String(chatId), kind: "message", promptHash: kernelPromptHash() });
    let foldCtx: { kernel: FoldableKernel; config: unknown } | undefined;
    let budget: ReturnType<typeof enforceRunBudget> | undefined;
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
      budget = makeRunBudget();
      // AG-015/B5: assigned once withTurnTimeout arms below; referenced here
      // by closure before that happens — see the ordering note on touch().
      let touch: (() => void) | undefined;
      const config = {
        configurable: {
          thread_id: threadIdFor(chatId),
          ...(profileId ? { profile_id: profileId } : {}),
          // Fine-grained keep-alive for a single long tool call (claude_code,
          // own budget 15min) that yields no new LangGraph state for its whole
          // run — src/agents/agent-tools/engineering.ts reads this.
          onTurnActivity: () => touch?.(),
        },
        recursionLimit: OFFICE_RECURSION_LIMIT,
        callbacks: [budget.callback, new TraceCallback(trace)],
      };
      foldCtx = { kernel: kernel as unknown as FoldableKernel, config };
      trace.event("turn.in", { textPreview: text.slice(0, 120) });

      // On deadline OR on a blown budget the run is ABORTED, not abandoned —
      // the signal goes only to stream() so the post-timeout fold/getState
      // still work on a clean config.
      const abort = budget;
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
          () => touch?.(),
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.invoke",
        () => abort.abort(),
        // Ordering: this fires synchronously inside withTurnTimeout, which is
        // called AFTER the two `touch?.()` closures above are already
        // constructed (JS evaluates call arguments before invoking) but
        // BEFORE either closure is ever actually invoked (that needs a real
        // graph state or tool progress line, both well after this point) —
        // so `touch` is always assigned by the time it matters.
        (fn) => {
          touch = fn;
        },
      );

      const approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title });
        const pendingRecord = await getPendingInterrupt(threadIdFor(chatId));
        const nonce = pendingRecord?.interrupt_id?.substring(0, 8);
        await sendApprovalCard(ctx, approval, nonce);
        return;
      }

      const reply = kernelReply(res as never);
      trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
      await sendReply(ctx, reply);
    } catch (err) {
      const failure = budget ? failureFor(err, budget) : err;
      trace.event("turn.error", {
        message: failure instanceof Error ? failure.message.slice(0, 400) : String(failure),
      });
      if (foldCtx) await recordFailedTurnInHistory(foldCtx.kernel, foldCtx.config, failure);
      // A live text turn can be replayed verbatim, so provider exhaustion auto-retries.
      await replyForError(ctx, failure, { chatId: String(chatId), text, turnId: trace.turnId });
    }
  });
}

// ── Resume after an approval decision ─────────────────────────────────────────

export async function resumeKernel(ctx: Context, decision: "approved" | "rejected", nonce?: string): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  await withChatTurnLock(chatId, async () => {
    const threadId = threadIdFor(chatId);
    const trace = startTurn({ chatId: String(chatId), kind: "resume", promptHash: kernelPromptHash() });
    let foldCtx: { kernel: FoldableKernel; config: unknown } | undefined;
    let budget: ReturnType<typeof enforceRunBudget> | undefined;
    try {
      const pending = await getPendingInterrupt(threadId);
      if (nonce && pending && !pending.interrupt_id.startsWith(nonce)) {
        log.warn({ expected: pending.interrupt_id, received: nonce }, "Rejected stale HITL card tap");
        await ctx.reply("⚠️ This approval card is expired or belongs to an older task.", { parse_mode: "HTML" });
        return;
      }
      if (pending) {
        await resolveInterrupt(pending.interrupt_id, decision);
      }
      const kernel = await getKernel();
      budget = makeRunBudget();
      let touch: (() => void) | undefined;
      const config = {
        configurable: { thread_id: threadId, onTurnActivity: () => touch?.() },
        recursionLimit: OFFICE_RECURSION_LIMIT,
        callbacks: [budget.callback, new TraceCallback(trace)],
      };
      foldCtx = { kernel: kernel as unknown as FoldableKernel, config };
      trace.event("hitl.resume", { decision });

      const abort = budget;
      let approval: ApprovalRequest | null = null;
      try {
        const res = await withTurnTimeout(
          streamKernelTurn(
            ctx,
            trace,
            kernel.stream(new Command({ resume: decision }), {
              ...config,
              streamMode: "values",
              signal: abort.signal,
            }) as Promise<AsyncIterable<unknown>>,
            () => touch?.(),
          ),
          OFFICE_TURN_TIMEOUT_MS,
          "kernel.resume",
          () => abort.abort(),
          (fn) => {
            touch = fn;
          },
        );

        // A multi-step plan can pause again on the NEXT gated step.
        approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
        if (approval) {
          trace.event("hitl.interrupt", { title: approval.title });
          await sendApprovalCard(ctx, approval);
          return;
        }

        const reply = kernelReply(res as never);
        trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
        await sendReply(ctx, reply);
      } finally {
        // AG-015/B7: runs on every exit above — success, re-pause, timeout,
        // or any other error. See resume-artifact-cleanup.ts for why.
        await cleanupResumeArtifact(kernel, config, threadId, decision, approval);
      }
      return;
    } catch (err) {
      const failure = budget ? failureFor(err, budget) : err;
      trace.event("turn.error", {
        message: failure instanceof Error ? failure.message.slice(0, 400) : String(failure),
      });
      if (foldCtx) await recordFailedTurnInHistory(foldCtx.kernel, foldCtx.config, failure);
      await replyForError(ctx, failure);
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
