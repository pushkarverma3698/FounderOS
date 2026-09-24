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
  opts: { afterRestart?: boolean; nonce?: string } = {},
): { html: string; keyboard: InlineKeyboard } {
  // Nonce (when provided) prefixes the callback data so a stale card from a
  // previous mission is rejected by the handler. Without it a button that
  // editMessageReplyMarkup failed to clear can resume the wrong checkpoint.
  const suffix = opts.nonce ? `:${opts.nonce}` : "";
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
