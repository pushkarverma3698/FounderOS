/**
 * Apply queue: the four groups (pure)
 * ===================================
 * One open role, one group, read from the shadow apply lane (`apply_lane` + `apply_lane_reason`):
 *   ready   lane auto: every field filled, no bot check. A send waits for his tap.
 *   answer  lane needs_you: one or more required questions need him.
 *   mac     hand_off with a bot-check reason (`isMacEligibleReason`): a click on his Mac solves it.
 *   site    any other hand_off: Workday, a form the bot cannot use. He finishes it on the company's site.
 * The Telegram digest counts these and the Mini App queue page lists them, from this one rule.
 */

import { isMacEligibleReason } from "./mac-worker-rules.js";

export type QueueGroup = "ready" | "answer" | "mac" | "site";
export const QUEUE_GROUPS: readonly QueueGroup[] = ["ready", "answer", "mac", "site"];
export const QUEUE_GROUP_TITLE: Readonly<Record<QueueGroup, string>> = {
  ready: "Ready to send",
  answer: "Need one answer",
  mac: "Need a click on your Mac",
  site: "Need you on the site",
};

export interface QueueLaneFields {
  readonly apply_lane: string | null;
  readonly apply_lane_reason: string | null;
}

/** The group a row waits in, or null when nothing waits on him (an auto row that was already sent, no lane). */
export function queueGroupOf(row: QueueLaneFields): QueueGroup | null {
  if (row.apply_lane === "auto") return (row.apply_lane_reason ?? "").startsWith("auto-sent") ? null : "ready";
  if (row.apply_lane === "needs_you") return "answer";
  if (row.apply_lane === "hand_off") return isMacEligibleReason(row.apply_lane_reason) ? "mac" : "site";
  return null;
}

export type QueueCounts = Readonly<Record<QueueGroup, number>>;

export function countQueue(rows: readonly QueueLaneFields[]): QueueCounts {
  const counts: Record<QueueGroup, number> = { ready: 0, answer: 0, mac: 0, site: 0 };
  for (const r of rows) {
    const g = queueGroupOf(r);
    if (g) counts[g] += 1;
  }
  return counts;
}

export const queueTotal = (c: QueueCounts): number => c.ready + c.answer + c.mac + c.site;
