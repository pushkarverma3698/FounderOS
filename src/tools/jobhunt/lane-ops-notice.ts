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

/** Send a lane-health message (HTML) to the founder private chat. Rejects when Telegram does, like sendToJobsChat. */
export async function sendLaneOps(text: string): Promise<void> {
  await sendToChat(text);
}
