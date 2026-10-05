/**
 * FounderOS — sends the evening merge list
 * ========================================
 * Daily at 19:00 in the founder's timezone (`appTimeZone()`: the server stays on UTC, so an unqualified "0 19" would
 * fire at 00:30 IST). Reads every dispatch repository, and sends ONE message when something is ready to merge or a
 * repository could not be read. Nothing ready and nothing unreadable sends nothing.
 *
 * It does not merge anything and it is not the `PR_BRAIN_MERGE` switch. The merge happens only when the founder taps
 * a button (merge-digest-callback.ts).
 */

import cron from "node-cron";
import { appTimeZone } from "../core/time.js";
import { childLogger } from "../infra/logger.js";
import { sendToChatWithKeyboard } from "../infra/telegram-send.js";
import { renderMergeDigest, type MergeDigest } from "./merge-digest.js";
import { fetchDispatchTasks, type TasksView } from "./tasks-command.js";

const log = childLogger({ module: "gateway:merge-digest-run" });

/** Daily 19:00, evaluated in `appTimeZone()`. */
export const MERGE_DIGEST_CRON = "0 19 * * *";

export interface MergeDigestRunDeps {
  readonly fetch: () => Promise<TasksView>;
  readonly send: (digest: MergeDigest) => Promise<void>;
}

const liveDeps: MergeDigestRunDeps = {
  fetch: () => fetchDispatchTasks(),
  send: (d) => sendToChatWithKeyboard(d.text, d.buttons.map((b) => [{ text: b.label, callback_data: b.data }])),
};

/** Sends the list. Resolves to whether a message went out. A failed send throws: the caller logs it. */
export async function runMergeDigest(deps: MergeDigestRunDeps = liveDeps): Promise<boolean> {
  const view = await deps.fetch();
  const digest = renderMergeDigest(view.readyToMerge ?? [], view.unreachable);
  if (!digest) {
    log.info("Merge digest: nothing ready, nothing unreadable, no message sent");
    return false;
  }
  await deps.send(digest);
  log.info({ buttons: digest.buttons.length, unreachable: view.unreachable.length }, "Merge digest sent");
  return true;
}

export function startMergeDigestCron(): void {
  const timezone = appTimeZone();
  cron.schedule(
    MERGE_DIGEST_CRON,
    () => {
      runMergeDigest().catch((err) => log.error({ err: (err as Error).message }, "Merge digest cron error"));
    },
    { timezone },
  );
  log.info({ cron: MERGE_DIGEST_CRON, timezone }, "Merge digest scheduled (daily, zero LLM, silent when nothing is ready)");
}
