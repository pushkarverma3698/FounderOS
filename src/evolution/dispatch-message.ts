/**
 * Evolution Engine — the founder-facing message for the acting loop.
 * ===================================================================
 * Pure rendering, separated from `dispatch-findings.ts` for the same reason
 * `audit-message.ts` is separate from `audit-sweep.ts`: the escaping rules are
 * the thing most likely to silently break the send, and they are only testable
 * if nothing here touches the network.
 *
 * Telegram accepts a fixed HTML tag whitelist and returns 400 on anything else.
 * Finding subjects routinely contain `<n>`, `<uuid>` and `<url>` — placeholders
 * `normalizeFailureSignature` (src/kernel/lessons.ts) writes deliberately — so
 * every value derived from a finding is escaped. Only the literal markup in this
 * file is raw.
 *
 * Each branch ends in something the founder can act on, or says plainly that
 * there is nothing to do. "The loop ran" is not an outcome (CLAUDE.md #26).
 */

import { escapeHtml } from "./audit-message.js";
import type { DispatchOutcome } from "./dispatch-findings.js";

export function renderDispatchMessage(outcome: DispatchOutcome): string {
  switch (outcome.state) {
    case "disabled":
      return [
        "🔕 <b>Self-improvement dispatch is OFF</b>",
        "",
        "<code>SELF_IMPROVE_DISPATCH_ENABLED=false</code> — no audit was run and no issue was filed.",
        "Remove that line from <code>.env</code> and restart to turn the loop back on.",
      ].join("\n");

    case "nothing-dispatchable":
      return [
        "✅ <b>Self-improvement: nothing to hand off</b>",
        "",
        `The audit found ${outcome.totalFindings} finding(s), none of a kind an unattended executor should be`,
        "given — cost hotspots, orphan modules and dead exports need a decision, not an implementation.",
        "",
        "They are all listed in the 08:00 audit report. Nothing is required from you.",
      ].join("\n");

    case "all-filed":
      return [
        "⏳ <b>Self-improvement: the queue is full, not empty</b>",
        "",
        `All ${outcome.dispatchableCount} actionable finding(s) already have an issue open or closed.`,
        "Nothing new was filed. The backlog is with the dispatcher and review, not with the audit.",
        "",
        "Check it with: <code>gh issue list --label evolution:auto</code>",
      ].join("\n");

    case "filed":
      return [
        "🛠 <b>Self-improvement filed an issue</b>",
        "",
        `<a href="${escapeHtml(outcome.url)}">#${outcome.issueNumber}</a> · ` +
          `<b>${escapeHtml(outcome.finding.kind)}</b> · ${escapeHtml(outcome.finding.severity)}`,
        `Subject: <code>${escapeHtml(outcome.finding.subject)}</code>`,
        "",
        escapeHtml(outcome.finding.evidence),
        "",
        "<b>What happens next, without you:</b>",
        "1. <code>agent-dispatch</code> claims it within 15 min and Antigravity implements it in an isolated workspace.",
        "2. A <b>draft</b> PR opens against <code>beta</code>.",
        "3. <code>pr-brain</code> reviews it within 20 min and approves, fixes, or requests changes.",
        "",
        "<b>You only act at the merge.</b> To stop it now: " +
          `<code>gh issue edit ${outcome.issueNumber} --remove-label agent:ready</code>`,
      ].join("\n");

    case "failed":
      return [
        "⚠️ <b>Self-improvement loop FAILED</b>",
        "",
        "No issue was filed. This is the loop breaking, not a clean run:",
        `<code>${escapeHtml(outcome.reason)}</code>`,
      ].join("\n");
  }
}
