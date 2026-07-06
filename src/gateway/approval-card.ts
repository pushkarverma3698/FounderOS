/**
 * FounderOS — HITL approval card formatting (shared by Telegram + web gateways).
 */

import { InlineKeyboard } from "grammy";
import type { ApprovalRequest } from "../agents/agent-tools.js";

/** Escape special HTML characters for Telegram HTML parse mode. */
export function safeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the HTML body + inline keyboard for an approval card.
 *
 * H1 fix: when `interruptId` is known, callback data is `approve:<id>` /
 * `reject:<id>` so a tap can only resume the SPECIFIC action the card was
 * rendered for. Without an id (legacy path, or a caller that couldn't look one
 * up), callback data falls back to the bare "approve"/"reject" — the resume
 * handler treats that as "no binding to check" rather than failing.
 */
export function formatApprovalCard(
  approval: ApprovalRequest,
  opts: { afterRestart?: boolean; interruptId?: string } = {},
): { html: string; keyboard: InlineKeyboard } {
  const suffix = opts.interruptId ? `:${opts.interruptId}` : "";
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve${suffix}`)
    .text("❌ Reject", `reject${suffix}`);
  const preview = approval.preview ? `\n\n<i>${safeHtml(approval.preview.slice(0, 1500))}</i>` : "";
  const prefix = opts.afterRestart
    ? `⏸️ <b>Resuming after restart</b> — still waiting on your approval:\n\n`
    : "";
  return {
    html: `${prefix}${safeHtml(approval.title)}\n${safeHtml(approval.summary)}${preview}`,
    keyboard,
  };
}
