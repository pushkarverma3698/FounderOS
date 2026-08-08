/**
 * Evolution Engine — 3-Day Self-Audit & Experience Sweep
 * =======================================================
 * Runs static & telemetry self-audits over 3 days of turn logs,
 * failure lessons, and friction signatures, reporting to Telegram.
 */

import { sendToChat } from "../infra/telegram-send.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "audit-sweep" });

export async function runSelfAuditSweep(): Promise<void> {
  try {
    const { runSelfAudit } = await import("../../scripts/audit-self.js");
    const report = await runSelfAudit();
    await sendToChat(report, "HTML");
    log.info("3-day self-audit sweep completed and sent to chat");
  } catch (err) {
    log.error({ err: (err as Error).message }, "Self-audit sweep error (non-fatal)");
  }
}
