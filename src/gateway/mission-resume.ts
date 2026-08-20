/**
 * FounderOS v3 — boot-time mission resume (gateway).
 * ===================================================
 * A hard crash mid-mission (OOM, power loss, kill -9) leaves the thread
 * checkpoint with pending graph nodes but NO pending HITL interrupt and NO
 * folded FailureReport — the founder got neither a reply nor an error, and
 * until now nothing ever picked that mission back up: boot recovery only
 * re-posted HITL cards. This module closes that gap: at startup it inspects
 * the founder thread's checkpoint and, when it carries the crash signature,
 * continues the graph from the last valid node state (`stream(null)`), under
 * the same lock / halt / budget / timeout / failure-fold discipline as every
 * other turn path.
 *
 * The crash signature is deliberately narrow so nothing else can trigger it:
 *   - `next` non-empty          → the run stopped between nodes, mid-flight
 *   - no task interrupts        → not an HITL pause (restorePendingApproval owns those)
 *   - `failure` is null         → not a handled failure (timeout/budget/model
 *                                 errors are folded by recordFailedTurnInHistory)
 *   - `reply` is empty          → the turn never completed
 *   - mission executing/synthesizing → the plan node had already committed to work
 *   - checkpoint fresh          → stale missions stay paused, never spontaneously re-run
 *
 * Re-running the interrupted node is safe by construction: external sends are
 * idempotency-keyed and gated behind interrupt() BEFORE any side effect — each
 * side-effecting tool in src/agents/agent-tools/ calls hitlGate() inline, in
 * that order — so a resumed step can at worst repeat read-only work.
 */

import { TENANT, DAILY_BUDGET_USD, OFFICE_TURN_TIMEOUT_MS, OFFICE_RECURSION_LIMIT } from "../core/config.js";
import { withTurnTimeout } from "./turn-timeout.js";
import { getKernel } from "./kernel-boot.js";
import { kernelReply, getPendingKernelApproval } from "../kernel/index.js";
import type { ApprovalRequest } from "../infra/hitl.js";
import { formatApprovalCard, safeHtml } from "./approval-card.js";
import { markdownToTelegramHtml, splitForTelegram } from "./format.js";
import { getTodayCostUsd } from "../db/queries.js";
import { BudgetGuardCallback, createRunBudget } from "../infra/budget.js";
import { assertDailyBudgetAllowsRun, DailyBudgetExceededError } from "../infra/daily-budget.js";
import { readHalt } from "../infra/halt.js";
import { startTurn } from "../infra/trace.js";
import { TraceCallback } from "../infra/trace-callback.js";
import { kernelPromptHash } from "./prompt-version.js";
import { logger } from "../infra/logger.js";
import { withChatTurnLock, threadIdFor, kernelCostSink } from "./kernel-run.js";
import { recordFailedTurnInHistory, type FoldableKernel } from "./failed-turn-fold.js";
import { getBot } from "./telegram.js";

const log = logger.child({ module: "mission-resume" });

/** Only resume missions whose checkpoint is younger than this (same window as HITL card restore). */
export const MISSION_RESUME_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Structural view of a LangGraph StateSnapshot — only the fields the decision needs. */
export interface MissionSnapshot {
  next?: readonly string[];
  createdAt?: string;
  tasks?: ReadonlyArray<{ interrupts?: ReadonlyArray<unknown> }>;
  values?: {
    mission?: { status?: string; goal?: string };
    reply?: string;
    failure?: unknown;
  };
}

export type ResumeDecision = { resume: true } | { resume: false; reason: string };

/**
 * Pure predicate: does this checkpoint carry the crash signature?
 * Every skip names its reason so the boot log says exactly why nothing ran.
 */
export function resumeDecision(snapshot: MissionSnapshot | undefined, now: number = Date.now()): ResumeDecision {
  const skip = (reason: string): ResumeDecision => ({ resume: false, reason });
  if (!snapshot) return skip("no checkpoint for this thread");
  if (!snapshot.next || snapshot.next.length === 0) return skip("no pending graph nodes — nothing was in flight");
  const interrupts = (snapshot.tasks ?? []).flatMap((t) => t.interrupts ?? []);
  if (interrupts.length > 0) return skip("paused at an HITL interrupt — the approval card path owns this");
  const values = snapshot.values ?? {};
  if (values.failure != null) return skip("failure already folded — the founder was told");
  if (values.reply) return skip("turn already produced a reply");
  const status = values.mission?.status ?? "";
  if (status !== "executing" && status !== "synthesizing") {
    return skip(`mission status "${status}" is not mid-run`);
  }
  if (!snapshot.createdAt) return skip("checkpoint has no timestamp — cannot age-check, staying conservative");
  const age = now - new Date(snapshot.createdAt).getTime();
  if (!Number.isFinite(age)) return skip("checkpoint timestamp unparsable — staying conservative");
  // Negative age = written after `now` (clock skew): that is a FRESH checkpoint, not a stale one.
  if (age > MISSION_RESUME_MAX_AGE_MS) return skip("checkpoint older than the resume window");
  return { resume: true };
}

async function notifyChat(chatId: string, html: string): Promise<void> {
  await getBot()
    .api.sendMessage(chatId, html, { parse_mode: "HTML" })
    .catch((err) => log.warn({ err: String(err) }, "Mission-resume notify failed")); // allow-failopen: a notify blip must not kill the resume; the checkpoint still holds the state
}

async function sendChunkedReply(chatId: string, reply: string): Promise<void> {
  const html = markdownToTelegramHtml(reply);
  for (const chunk of splitForTelegram(html)) {
    await getBot()
      .api.sendMessage(chatId, chunk, { parse_mode: "HTML" })
      .catch(async () => {
        // Telegram rejected the HTML (edge-case entities) — send plain, never drop.
        await getBot().api.sendMessage(chatId, reply.slice(0, 4000));
      });
  }
}

/** Collect the final state from a values-mode kernel stream (no progress UI at boot). */
async function collectFinalState(streamPromise: Promise<AsyncIterable<unknown>>): Promise<unknown> {
  let last: unknown;
  for await (const state of await streamPromise) last = state;
  if (last === undefined) {
    throw new Error("kernel.stream produced no state — this should be unreachable (graph always yields at least once)");
  }
  return last;
}

/**
 * Resume the founder thread's crashed mission, if any. Returns true when a
 * resume was ATTEMPTED (success, HITL pause, or loud failure — all reported
 * to the founder); false when the checkpoint carried no crash signature or a
 * gate declined the run. Called once from src/index.ts after HITL restore.
 */
export async function resumeInterruptedMission(chatId: string): Promise<boolean> {
  return withChatTurnLock(chatId, async () => {
    const halt = await readHalt();
    if (halt) {
      log.info({ chatId }, "Mission resume skipped — system halted");
      return false;
    }

    const kernel = await getKernel();
    const threadId = threadIdFor(chatId);
    const snapshot = (await kernel.getState({ configurable: { thread_id: threadId } })) as MissionSnapshot;
    const decision = resumeDecision(snapshot);
    if (!decision.resume) {
      log.info({ chatId, reason: decision.reason }, "No interrupted mission to resume");
      return false;
    }

    try {
      await assertDailyBudgetAllowsRun(
        () => getTodayCostUsd(TENANT),
        DAILY_BUDGET_USD,
        (msg) => log.warn({ chatId, err: msg }, "Daily budget check skipped — fail-open"),
      );
    } catch (err) {
      if (err instanceof DailyBudgetExceededError) {
        await notifyChat(
          chatId,
          `🛑 <b>An interrupted task was NOT resumed</b> — daily budget cap reached. ` +
            `It stays paused; re-send the request once the budget resets. Check spend: /budget`,
        );
        return false;
      }
      throw err;
    }

    const trace = startTurn({ chatId, kind: "resume", promptHash: kernelPromptHash() });
    const config = {
      configurable: { thread_id: threadId },
      recursionLimit: OFFICE_RECURSION_LIMIT,
      callbacks: [
        new BudgetGuardCallback(createRunBudget(), process.env["AGENT_MODEL"] ?? "", kernelCostSink),
        new TraceCallback(trace),
      ],
    };
    const goal = snapshot.values?.mission?.goal ?? "";
    trace.event("turn.in", { textPreview: `[mission-resume] ${goal.slice(0, 100)}` });

    try {
      await notifyChat(
        chatId,
        `🔄 <b>Resuming the task interrupted by the restart</b>\n<code>${safeHtml(goal.slice(0, 300))}</code>`,
      );

      // null input = continue this thread from its last valid checkpoint.
      // On deadline the run is ABORTED, not abandoned — the signal goes only to
      // stream() so the post-timeout fold/getState still work on a clean config.
      const abort = new AbortController();
      const res = await withTurnTimeout(
        collectFinalState(
          kernel.stream(null, { ...config, streamMode: "values", signal: abort.signal }) as Promise<AsyncIterable<unknown>>,
        ),
        OFFICE_TURN_TIMEOUT_MS,
        "kernel.mission-resume",
        () => abort.abort(),
      );

      // The resumed run can pause on a gated step — same card path as a live turn.
      const approval = (await getPendingKernelApproval(kernel, config)) as ApprovalRequest | null;
      if (approval) {
        trace.event("hitl.interrupt", { title: approval.title });
        const card = formatApprovalCard(approval);
        await getBot().api.sendMessage(chatId, card.html, { parse_mode: "HTML", reply_markup: card.keyboard });
        return true;
      }

      const reply = kernelReply(res as never);
      trace.event("turn.out", { replyPreview: reply.slice(0, 200) });
      await sendChunkedReply(chatId, reply);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      trace.event("turn.error", { message: message.slice(0, 400) });
      // Same fold as a live turn: the failure must be visible to the NEXT turn's planner.
      await recordFailedTurnInHistory(kernel as unknown as FoldableKernel, config, err);
      await notifyChat(chatId, `❌ <b>Resume failed</b>\n<code>${safeHtml(message.slice(0, 500))}</code>`);
      return true;
    }
  });
}
