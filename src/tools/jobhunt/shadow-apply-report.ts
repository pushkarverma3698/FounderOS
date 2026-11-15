/**
 * Shadow apply: the one Telegram summary per run (HTML, split rather than cut).
 */

import type { ApplyLane } from "./apply-lane.js";
import { esc } from "./telegram-format.js";

export interface ShadowRoutedRow {
  readonly company: string;
  readonly title: string;
  readonly profileId: string;
  readonly lane: ApplyLane;
  readonly reason: string;
}

const MAX_MESSAGE_CHARS = 3500;
const LANE_LABEL: Readonly<Record<ApplyLane, string>> = { auto: "auto", needs_you: "needs you", hand_off: "hand-off" };

/** "Shadow apply: N prepared — auto X, needs you Y, hand-off Z", then a line per role. Never drops a row. */
export function formatShadowSummary(rows: readonly ShadowRoutedRow[]): string[] {
  if (rows.length === 0) return [];
  const count = (lane: ApplyLane): number => rows.filter((r) => r.lane === lane).length;
  const header = `<b>Shadow apply: ${rows.length} prepared — auto ${count("auto")}, needs you ${count("needs_you")}, hand-off ${count("hand_off")}</b>`;
  const lines = rows.map(
    (r) => `• <b>${esc(r.company)}</b>, ${esc(r.title)} (${esc(r.profileId)}): ${LANE_LABEL[r.lane]} — ${esc(r.reason)}`,
  );
  const messages: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current.length + line.length + 1 > MAX_MESSAGE_CHARS && current !== header && current.length > 0) {
      messages.push(current);
      current = "";
    }
    current = current === "" ? line : `${current}\n${line}`;
  }
  messages.push(current);
  return messages;
}
