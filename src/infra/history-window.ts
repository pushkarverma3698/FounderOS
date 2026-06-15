/**
 * FounderOS — Conversation History Window
 * ========================================
 * The PERMANENT fix for the "loops / same reply to every question" bug.
 *
 * The Telegram gateway uses a stable thread_id per chat, so the Postgres
 * checkpointer accumulates the entire conversation forever. Old turns get
 * replayed into the model on every message, and the supervisor anchors on stale
 * state (e.g. staying consistent with an earlier refusal). The only mitigation
 * used to be the manual /reset command.
 *
 * `computeHistoryTrim` is a PURE function that decides which messages to delete
 * (by id) so the persisted thread is bounded to the last N human turns. The
 * gateway calls it after each clean turn and applies the removals via
 * RemoveMessage + updateState (only when no approval is pending).
 *
 * Invariant: the kept window always STARTS on a HumanMessage. Gemini rejects a
 * message list that begins with an orphaned tool message, so we never cut in the
 * middle of a tool round — we cut on a human-turn boundary.
 */

import type { BaseMessage } from "@langchain/core/messages";

/**
 * How many human turns of history to keep by default. Small on purpose — the
 * supervisor forwards the whole kept window to sub-agents on handoff, so stale
 * leading messages leak into routing (prod 2026-06-15). The gateway passes
 * HISTORY_KEEP_TURNS (config) explicitly; this is only the bare-call fallback.
 */
export const DEFAULT_KEEP_TURNS = 4;

export interface HistoryTrim {
  /** Message ids to delete from the checkpointer (RemoveMessage targets). */
  toRemove: string[];
  /** The messages that remain after trimming (kept window). */
  toKeep: BaseMessage[];
}

/**
 * Decide which messages to trim so only the last `keepTurns` human turns remain.
 * Pure — no graph or DB access. The boundary lands on a HumanMessage so the kept
 * window is always a valid human-led sequence.
 */
export function computeHistoryTrim(
  messages: BaseMessage[],
  opts: { keepTurns?: number } = {},
): HistoryTrim {
  const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;

  // Walk backwards; the boundary is the index of the keepTurns-th human message.
  let humanCount = 0;
  let boundary = 0; // default: keep everything (nothing to remove)
  let found = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (typeOf(messages[i]!) === "human") {
      humanCount++;
      if (humanCount >= keepTurns) {
        boundary = i;
        found = true;
        break;
      }
    }
  }

  // Fewer than keepTurns human turns → keep everything.
  if (!found) return { toRemove: [], toKeep: messages.slice() };

  const toKeep = messages.slice(boundary);
  const toRemove = messages
    .slice(0, boundary)
    .map((m) => (m as { id?: string }).id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  return { toRemove, toKeep };
}

function typeOf(m: BaseMessage): string {
  return (m as { _getType?: () => string })._getType?.() ?? "";
}
