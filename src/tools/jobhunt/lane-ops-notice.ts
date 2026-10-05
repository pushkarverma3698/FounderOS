/**
 * FounderOS - lane health notices go to the founder, not the jobs group
 * ====================================================================
 * The family jobs group is for roles: the batched new-role message (alert-digest.ts) and the pipeline review.
 * Everything that says how the LANE is doing goes to the founder DM instead: the 3-hour alive ping, the
 * funnel-closed alert, "nothing was fetched", and "the job sheet could not be updated". Those are operator
 * facts. The candidate cannot act on them, and 48 sweeps a day turned them into most of the group traffic.
 *
 * One function in one file, so tests/unit/jobhunt/job-lane-chat-routing.test.ts can allow exactly this file to
 * use the founder-chat helper and keep forbidding it everywhere else in the job lane.
 */

import { sendToChat } from "../../infra/telegram-send.js";

/** How long a notice with a repeatKey stays quiet after it was delivered. */
export const LANE_OPS_REPEAT_MS = 6 * 60 * 60 * 1000;

/**
 * Last delivery per repeatKey. In memory on purpose: a restart sends one repeat, which is the right side to err on,
 * and a table for a courtesy DM would be a new thing to migrate and clean up.
 */
const lastSent = new Map<string, number>();

export function resetLaneOpsThrottle(): void {
  lastSent.clear();
}

/**
 * Send a lane-health message (HTML) to the founder private chat. Rejects when Telegram does, like sendToJobsChat.
 *
 * `repeatKey` is for a condition that persists: "nothing was fetched" and "the sheet could not be updated" would
 * otherwise repeat every 30-minute sweep for as long as the outage lasts. The window starts only after Telegram
 * accepted the message, so a failed send is retried by the next sweep.
 */
export async function sendLaneOps(text: string, opts: { repeatKey?: string } = {}): Promise<void> {
  const key = opts.repeatKey;
  if (key !== undefined) {
    const last = lastSent.get(key);
    if (last !== undefined && Date.now() - last < LANE_OPS_REPEAT_MS) return;
  }
  await sendToChat(text);
  if (key !== undefined) lastSent.set(key, Date.now());
}
