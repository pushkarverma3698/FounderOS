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

/** Build the HTML body + inline keyboard for an approval card. */
export function formatApprovalCard(
  approval: ApprovalRequest,
  opts: { afterRestart?: boolean } = {},
): { html: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard()
    .text("✅ Approve", "approve")
    .text("❌ Reject", "reject");
  const preview = approval.preview ? `\n\n<i>${safeHtml(approval.preview.slice(0, 1500))}</i>` : "";
  const prefix = opts.afterRestart
    ? `⏸️ <b>Resuming after restart</b> — still waiting on your approval:\n\n`
    : "";
  return {
    html: `${prefix}${safeHtml(approval.title)}\n${safeHtml(approval.summary)}${preview}`,
    keyboard,
  };
}
