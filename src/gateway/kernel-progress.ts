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

/** Planner prose is scrubbed of worker ids and tool names (rationale in kernel/founder-text.ts) and clipped. */
function cleanProse(text: string): string {
  const clean = redactInternalIdentifiers(redactInternalPaths(text));
  return clean.length > PROGRESS_OBJECTIVE_MAX ? `${clean.slice(0, PROGRESS_OBJECTIVE_MAX - 1)}…` : clean;
}

const stepsOf = (n: number): string => `${n} step${n === 1 ? "" : "s"}`;

/**
 * Step-level progress label for the CURRENT state, or null when nothing is
 * worth showing (failed/done, or a malformed cursor — mirrors dispatch's own
 * bounds check rather than throwing). Once the plan exists the founder sees,
 * in this order: "On it: <goal>, N steps" with the first step under it,
 * "Step k of N: <objective>" for each later step, "All N steps done" while
 * the reply is written.
 */
export function progressLabelFor(state: KernelStateType): string | null {
  const { mission } = state;
  if (!mission) return null; // first streamed snapshot, before the plan node has run
  if (mission.status === "planning") return "🧠 Planning…";
  const plan = mission.plan;
  if (mission.status === "executing") {
    const step = plan?.steps[mission.cursor];
    if (!plan || !step) return null;
    const objective = cleanProse(step.objective);
    if (!objective) return PROGRESS_PLACEHOLDER_TEXT;
    const line = `Step ${mission.cursor + 1} of ${plan.steps.length}: ${objective}`;
    if (mission.cursor > 0) return line;
    const goal = cleanProse(plan.goal);
    return `On it: ${goal || "your request"}, ${stepsOf(plan.steps.length)}\n${line}`;
  }
  if (mission.status === "synthesizing") {
    return plan ? `All ${stepsOf(plan.steps.length)} done` : "✍️ Writing your reply…";
  }
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
 *
 * `onActivity`, if given, fires on every yielded state — real sign of life for
 * `withTurnTimeout`'s `touch()` (AG-015/B5). A step that emits nothing new
 * (a single long tool call inside one graph node) gets no touch from HERE;
 * that granularity comes from the tool's own progress channel instead (see
 * `configurable.onTurnActivity` in kernel-run.ts) — this only covers step-to-
 * step activity.
 */
export async function streamKernelTurn(
  ctx: Context,
  trace: ReturnType<typeof startTurn>,
  streamPromise: Promise<AsyncIterable<unknown>>,
  onActivity?: () => void,
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
      onActivity?.();
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
