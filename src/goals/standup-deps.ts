/**
 * FounderOS — goals: the standup's real dependencies (composition)
 * ================================================================
 * The one place that binds the standup to the real world: Postgres, GitHub, Telegram, the halt flag and
 * the skipped-days file. Imported lazily by the cron tick, the boot catch-up and `pnpm goals:standup`,
 * so `startScheduler()` never pays for it and every other module stays testable with fakes.
 *
 * Nothing here can call a model. The kernel is reachable only from the "Plan next step" button, in
 * src/gateway/goal-commands.ts.
 */

import { TENANT } from "../core/config.js";
import { appTimeZone } from "../core/time.js";
import { readHalt } from "../infra/halt.js";
import { childLogger } from "../infra/logger.js";
import { sendToChatWithKeyboard } from "../infra/telegram-send.js";
import { createRealMetricDeps } from "./metric-deps.js";
import { createPgGoalRepo } from "./pg-repo.js";
import { createFileSkipLedger } from "./skipped.js";
import type { StandupDeps } from "./standup.js";

/** Production dependencies; `overrides` lets the CLI swap the sender or the metric sources for a dry proof. */
export function createStandupDeps(overrides: Partial<StandupDeps> = {}): StandupDeps {
  return {
    repo: createPgGoalRepo(),
    metrics: createRealMetricDeps(),
    send: (message) => sendToChatWithKeyboard(message.text, message.keyboard),
    readHalt,
    skips: createFileSkipLedger(),
    now: () => new Date(),
    timeZone: appTimeZone(),
    tenant: TENANT,
    log: childLogger({ module: "goals-standup" }),
    ...overrides,
  };
}
