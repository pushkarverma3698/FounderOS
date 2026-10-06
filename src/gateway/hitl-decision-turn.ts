/**
 * FounderOS - an approve / reject tap is a turn too
 * =================================================
 * The founder's yes or no on an approval card is something he did, and "what did I approve today" reads
 * conversation_turns. The tap resumes the paused kernel run, but the kernel files only the turn that raised
 * the card (under the instruction that raised it), never the decision, so a rejected send or an approved
 * deploy left no trace of the decision itself.
 *
 * One row per decided card, keyed on the interrupt id so a double tap or a redelivery is one row. Only the
 * card's title is kept: the preview and args can hold an email body or a shell command.
 *
 * Fire and forget: a lost row costs a later recall, never the approval.
 */

import { recordConversationTurn, type StoredTurn } from "../db/conversation-turns.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "hitl-decision-turn" });

/** Longest card title kept in the row. */
export const DECISION_TITLE_MAX_CHARS = 120;

export interface HitlDecisionInput {
  readonly interruptId: string;
  readonly decision: "approved" | "rejected";
  /** The pending row's callback_data: the serialized approval card, or null when unreadable. */
  readonly cardJson: string | null | undefined;
  readonly now: Date;
}

/** The card title, or null when the card is missing, unparseable or has no usable title. */
export function approvalCardTitle(cardJson: string | null | undefined): string | null {
  if (!cardJson) return null;
  try {
    const title = (JSON.parse(cardJson) as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) return null;
    return title.trim().slice(0, DECISION_TITLE_MAX_CHARS);
  } catch {
    // allow-failopen: an unreadable card only costs the title in the history row; the row is still filed
    return null;
  }
}

/** PURE: the row an approve or reject tap leaves. */
export function hitlDecisionTurn(input: HitlDecisionInput): StoredTurn {
  const verb = input.decision === "approved" ? "Approved" : "Rejected";
  const title = approvalCardTitle(input.cardJson);
  const line = title ? verb + ": " + title : verb + " an approval card";
  return {
    turn_id: "hitl-" + input.interruptId,
    at: input.now.toISOString(),
    user_input: line,
    goal: line,
    outcome: "done",
    reply: line,
  };
}

/** Fire and forget: file the decision under the chat's thread. */
export function recordHitlDecisionTurn(
  threadId: string,
  input: HitlDecisionInput,
  record: (threadId: string, turn: StoredTurn) => Promise<void> = recordConversationTurn,
): void {
  const turn = hitlDecisionTurn(input);
  // allow-failopen: a lost history row costs a later recall; it must never cost the founder his approval
  void record(threadId, turn).catch((err: unknown) => {
    log.warn({ err: String(err), turn_id: turn.turn_id }, "Approval decision not recorded");
  });
}
