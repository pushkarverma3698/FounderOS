/**
 * FounderOS — the failure card
 * ============================
 * What a failed task says to the founder: the objective that did not finish,
 * why, what DID finish, and a 🔁 Retry button.
 *
 * WHY A SECOND RENDERING. `formatFailureReply` (src/kernel/supervisor.ts) is
 * the kernel's text for the same FailureReport — `Task stopped at step "s1" —
 * validation failure in kernel/worker` — and it stays exactly as it is: it is
 * stored as the turn's reply, which the next planner call reads as history.
 * This module only changes what is SENT. On 2026-09-16 the founder read that
 * line and typed "Try again" by hand, twice.
 *
 * The component is never hidden (CLAUDE.md: failures name the real component,
 * and the founder always sees them). It moves into an expandable block under
 * the plain-words headline, with the unredacted message and the evidence.
 *
 * Objective and reason pass through the same scrubbing the progress label uses
 * (redactInternalPaths → redactInternalIdentifiers, see kernel/founder-text.ts):
 * planner objectives routinely name tools, and a snake_case id is not a reason.
 */

import type { Context } from "grammy";
import {
  redactInternalIdentifiers,
  redactInternalPaths,
  type FailureReport,
  type KernelStateType,
  type StepResult,
} from "../kernel/index.js";
import { safeHtml } from "./approval-card.js";
import { TELEGRAM_MAX } from "./format.js";
import { retryKeyboard } from "./retry-button.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "failure-card" });

const OBJECTIVE_MAX = 200;
const REASON_MAX = 400;
const STEP_SUMMARY_MAX = 150;
const DETAIL_MESSAGE_MAX = 800;
const EVIDENCE_MAX = 400;

/** Sent after the plain text when the card itself cannot go out, so the button is never lost. */
const RETRY_ONLY_TEXT = "⚠️ That task didn't finish. 🔁 Retry runs it again from the start — nothing is sent twice without your OK.";

type CardState = Pick<KernelStateType, "failure" | "results" | "mission" | "turn">;

export interface FailureCard {
  readonly html: string;
  /** Absent when the retry payload cannot fit Telegram's 64 bytes (retry-button.ts). */
  readonly keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Planner prose for the founder: no paths, no tool ids. Empty when nothing but ids was there. */
function words(text: string): string {
  // A removed identifier can strand a space before punctuation ("did not match : missing").
  return redactInternalIdentifiers(redactInternalPaths(text)).replace(/\s+([:;,.])/g, "$1");
}

function objectiveOf(state: CardState, stepId: string): string | undefined {
  return state.mission?.plan?.steps.find((s) => s.step_id === stepId)?.objective;
}

function outputSummary(result: StepResult & { status: "ok" }): string {
  const raw = typeof result.output === "string" ? result.output : JSON.stringify(result.output ?? "");
  return clip(redactInternalPaths(raw ?? ""), STEP_SUMMARY_MAX);
}

/** The card's HTML. `retry` says whether a button will be attached, so the text never promises one that is not there. */
export function renderFailureCard(state: CardState, opts: { retry: boolean }): string {
  const failure = state.failure as FailureReport;
  const request = state.turn?.raw_input || state.mission?.goal || "";
  const objective =
    words(objectiveOf(state, failure.step_id) ?? "") || words(request) || "your request";
  const reason = words(failure.message) || "the step failed";

  const lines = [
    `⚠️ <b>I couldn't finish:</b> ${safeHtml(clip(objective, OBJECTIVE_MAX))}`,
    `<b>Why:</b> ${safeHtml(clip(reason, REASON_MAX))}`,
  ];

  const done = (state.results ?? []).filter((r): r is StepResult & { status: "ok" } => r.status === "ok");
  if (done.length > 0) {
    lines.push("", "✅ <b>Done before it stopped:</b>");
    for (const r of done) {
      const label = words(objectiveOf(state, r.step_id) ?? "") || `Step ${r.step_id}`;
      const summary = outputSummary(r);
      lines.push(`• ${safeHtml(clip(label, OBJECTIVE_MAX))}${summary ? ` — ${safeHtml(summary)}` : ""}`);
    }
  }

  const details = [`${failure.stage} · ${failure.component}`, clip(failure.message, DETAIL_MESSAGE_MAX)];
  if (failure.evidence) details.push(`Evidence: ${clip(failure.evidence, EVIDENCE_MAX)}`);
  lines.push("", `<blockquote expandable>${safeHtml(details.join("\n"))}</blockquote>`);

  if (opts.retry) {
    lines.push("<i>🔁 Retry runs it again from the start. Nothing is sent twice without your OK.</i>");
  }
  return lines.join("\n");
}

/**
 * The card for a turn that ended with `state.failure`, or null when there is
 * nothing to retry: no failure, or the founder himself rejected an approval
 * (`hitl_rejected` — the kernel's own "Nothing was sent" text is the answer).
 */
export function failureCardFor(
  state: CardState,
  opts: { turnId: string; profileId?: string },
): FailureCard | null {
  if (!state.failure || state.failure.stage === "hitl_rejected") return null;
  const keyboard = retryKeyboard(opts.turnId, opts.profileId);
  return {
    html: renderFailureCard(state, { retry: keyboard !== undefined }),
    ...(keyboard ? { keyboard } : {}),
  };
}

/**
 * Send the card. If it is too long for one message, or Telegram rejects it,
 * send the kernel's plain failure text instead (split, never truncated) and then
 * the button on its own — a card that cannot render must never cost him the
 * answer or the Retry.
 */
export async function replyWithFailureCard(
  ctx: Context,
  card: FailureCard,
  sendPlain: () => Promise<void>,
): Promise<void> {
  const fallback = async (): Promise<void> => {
    await sendPlain();
    if (card.keyboard) await ctx.reply(RETRY_ONLY_TEXT, { reply_markup: card.keyboard });
  };
  if (card.html.length > TELEGRAM_MAX) {
    log.warn({ chars: card.html.length }, "Failure card too long for one message — sending the plain text, then Retry");
    await fallback();
    return;
  }
  try {
    await ctx.reply(card.html, { parse_mode: "HTML", ...(card.keyboard ? { reply_markup: card.keyboard } : {}) });
  } catch (err) {
    // allow-failopen: the plain failure text is the fallback; the founder still gets the failure and the button.
    log.warn({ err: String(err) }, "Failure card rejected by Telegram — sending the plain failure text");
    await fallback();
  }
}
