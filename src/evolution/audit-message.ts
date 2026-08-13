/**
 * Evolution Engine — the founder-facing self-audit message.
 * ==========================================================
 * Task 3 (docs/plans/2026-08-13-task3-acting-loop-telemetry-wiring.md).
 *
 * Two things this module exists to guarantee, both of which the cron path got
 * wrong before it:
 *
 * 1. THE MESSAGE ARRIVES. `audit-sweep.ts` sends with `parse_mode: "HTML"` and
 *    escaped nothing, while `normalizeFailureSignature` (src/kernel/lessons.ts)
 *    deliberately writes `<n>`, `<uuid>`, `<hash>`, `<url>`, `<email>` and
 *    `<payload>` into the signatures that become finding subjects and evidence.
 *    Telegram accepts a fixed tag whitelist and 400s on anything else, so a
 *    single telemetry finding made the whole send fail — and the sweep's catch
 *    logged it and told the founder nothing. Everything derived from a finding
 *    is escaped here; only the literal markup in this file is raw.
 *
 * 2. A SENSOR THAT DID NOT RUN NEVER READS AS CLEAN. The skip banner is emitted
 *    from `telemetrySkippedReason` and names the analyzers that went dark.
 *
 * The message also ends in something actionable (CLAUDE.md #26): the delta since
 * the previous run, and REGRESSED findings — ones that were marked fixed and have
 * come back — called out separately instead of buried in the ranked list.
 */

import { renderReport } from "./report.js";
import type { AuditRunResult, PersistenceOutcome } from "./run-audit.js";
import { TELEMETRY_ANALYZERS } from "./run-audit.js";

/** Regressed findings listed by name before the rest collapse into a count. */
export const MAX_REGRESSED_SHOWN = 5;

/** Telegram HTML: escape the three characters that can open a tag or an entity. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The banner for a tier that produced no result. Deliberately does NOT say
 * "0 findings" anywhere — the whole point is that the count is unknown.
 */
function skipBanner(reason: string): string[] {
  return [
    "⚠️ <b>TELEMETRY DID NOT RUN</b>",
    `${escapeHtml(TELEMETRY_ANALYZERS.join(", "))} produced NO result this run.`,
    "This is not a clean result, it is no result.",
    `Reason: <code>${escapeHtml(reason)}</code>`,
    "",
  ];
}

/** The delta since the previous run — or an honest statement of why there is none. */
function deltaLines(persistence: PersistenceOutcome): string[] {
  if (persistence.state === "disabled") {
    return [
      "",
      "<i>Recurrence tracking is OFF (EVOLUTION_PERSIST_FINDINGS=false) — this run cannot say which findings are new, recurring or regressed.</i>",
    ];
  }

  const { result } = persistence;
  if (!result.persisted) {
    return [
      "",
      "⚠️ <b>Recurrence tracking failed to write this run</b> — new/recurring/regressed is UNKNOWN.",
      `Reason: <code>${escapeHtml(result.error ?? "unknown")}</code>`,
    ];
  }

  const lines = [
    "",
    `<b>Since last run:</b> ${result.newCount} new · ${result.recurringCount} recurring · ` +
      `${result.regressedCount} regressed · ${result.resolvedCount} resolved`,
  ];

  if (result.regressed.length > 0) {
    lines.push("", "⚠️ <b>REGRESSED</b> — marked fixed, now back:");
    for (const item of result.regressed.slice(0, MAX_REGRESSED_SHOWN)) {
      const where = item.location && item.location !== item.subject ? ` (${escapeHtml(item.location)})` : "";
      lines.push(`• ${escapeHtml(item.subject)}${where} — seen ${item.timesSeen}×`);
    }
    const withheld = result.regressed.length - MAX_REGRESSED_SHOWN;
    if (withheld > 0) lines.push(`+ ${withheld} more regressed (${result.regressed.length} total).`);
  }

  return lines;
}

/**
 * Render the complete Telegram message for one self-audit run.
 * Safe to pass straight to `sendToChat(text, "HTML")`.
 */
export function renderAuditMessage(run: AuditRunResult, persistence: PersistenceOutcome): string {
  const head = run.telemetrySkippedReason !== null ? skipBanner(run.telemetrySkippedReason) : [];
  const body = escapeHtml(renderReport(run.ranked));
  return [...head, body, ...deltaLines(persistence)].join("\n");
}

/**
 * The message sent when the audit itself threw. Previously this path sent
 * nothing at all: the sweep logged "non-fatal" and the founder could not tell a
 * crashed audit from a cron that never fired from an audit with no findings.
 */
export function renderAuditCrashMessage(reason: string): string {
  return [
    "⚠️ <b>SELF-AUDIT FAILED TO RUN</b>",
    "No findings were produced. This is not a clean result, it is no result.",
    `Reason: <code>${escapeHtml(reason)}</code>`,
  ].join("\n");
}
