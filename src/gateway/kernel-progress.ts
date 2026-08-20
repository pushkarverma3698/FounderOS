/**
 * Telegram progress streaming for a kernel turn.
 *
 * Split out of kernel-run.ts, which the LOC budget (400) caught at 401 once the
 * prompt-hash and cost-attribution work landed in the same run loop. Nothing here
 * is part of the run loop itself — it is the cosmetic placeholder that gets sent,
 * edited as the graph advances, and deleted when the turn ends.
 */
import { type Context } from "grammy";
import { redactInternalPaths, redactInternalIdentifiers } from "../kernel/index.js";
import type { KernelStateType } from "../kernel/index.js";
import { startTurn } from "../infra/trace.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "kernel-progress" });

const PROGRESS_OBJECTIVE_MAX = 60;

const PROGRESS_PLACEHOLDER_TEXT = "🤔 Working on it…";

/**
 * Step-level progress label for the CURRENT state, or null when nothing is
 * worth showing (planning/failed/done, or a malformed cursor — mirrors
 * dispatch's own bounds check rather than throwing).
 */
export function progressLabelFor(state: KernelStateType): string | null {
  const { mission } = state;
  if (!mission) return null; // first streamed snapshot, before the plan node has run
  if (mission.status === "executing") {
    const step = mission.plan?.steps[mission.cursor];
    if (!step) return null;
    // Worker id is internal routing; the objective is planner prose that names
    // tools. Both are scrubbed — rationale in kernel/founder-text.ts.
    const clean = redactInternalIdentifiers(redactInternalPaths(step.objective));
    if (!clean) return PROGRESS_PLACEHOLDER_TEXT;
    return `🔧 ${clean.length > PROGRESS_OBJECTIVE_MAX ? `${clean.slice(0, PROGRESS_OBJECTIVE_MAX - 1)}…` : clean}`;
  }
  if (mission.status === "synthesizing") return "✍️ Writing your reply…";
  return null;
}

/** Runs a Telegram progress call and swallows any failure — a progress ping is cosmetic; the turn must not die on a Telegram blip. */
async function silently(op: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log.warn({ err: String(err) }, `Progress placeholder ${op} failed`); // allow-failopen: progress ping is cosmetic; the turn must not die on a Telegram blip
  }
}

/**
 * Sends one placeholder message, edits it as progressLabelFor(state) changes
 * while streaming the kernel turn, and deletes it once the turn ends
 * (success, HITL pause, or error).
 */
export async function streamKernelTurn(
  ctx: Context,
  trace: ReturnType<typeof startTurn>,
  streamPromise: Promise<AsyncIterable<unknown>>,
): Promise<KernelStateType> {
  let placeholderId: number | undefined;
  await silently("send", async () => {
    placeholderId = (await ctx.reply(PROGRESS_PLACEHOLDER_TEXT)).message_id;
  });

  let lastLabel: string | null = null;
  let lastState: KernelStateType | undefined;

  try {
    const streamIter = await streamPromise;
    for await (const state of streamIter) {
      lastState = state as KernelStateType;
      const label = progressLabelFor(lastState);
      if (label === null || label === lastLabel) continue;
      lastLabel = label;
      trace.event("turn.progress", { label });
      const id = placeholderId;
      if (id !== undefined && ctx.chat) {
        const chatId = ctx.chat.id;
        await silently("edit", () => ctx.api.editMessageText(chatId, id, label));
      }
    }
  } finally {
    const id = placeholderId;
    if (id !== undefined && ctx.chat) {
      const chatId = ctx.chat.id;
      await silently("delete", () => ctx.api.deleteMessage(chatId, id));
    }
  }

  if (!lastState) {
    throw new Error("kernel.stream produced no state — this should be unreachable (graph always yields at least once)");
  }
  return lastState;
}
