/**
 * Deterministic Gmail inbox reads — bypass the LLM for simple read-only checks.
 * The comms agent was summarizing "you have unread emails" without calling
 * read_emails (live-verified T03). Pure detection + direct tool call (rule #16).
 */

import { readEmailsTool } from "../tools/email-reader.js";
import { isInboxReadOnlyRequest } from "./execution-guard.js";

export { isInboxReadOnlyRequest } from "./execution-guard.js";

export function inboxQueryForRequest(input: string): string {
  return /\bunread\b/i.test(input) ? "is:unread" : "in:inbox";
}

/**
 * Execute read_emails directly when the request is a simple inbox read.
 * Returns formatted text for Telegram, or null to fall through to the office.
 */
export async function tryInboxReadFastPath(input: string): Promise<string | null> {
  if (!isInboxReadOnlyRequest(input)) return null;

  const query = inboxQueryForRequest(input);
  const res = await readEmailsTool.execute({ query, max_results: 10 });
  if (!res.success) {
    const err = res.error ?? "unknown error";
    if (/not connected|gws CLI not installed/i.test(err)) {
      return `📭 Gmail is not connected on this host. ${err}`;
    }
    return `❌ Inbox read failed: ${err}. Check gws auth (\`gws auth status\`) or set GMAIL_BACKEND=composio.`;
  }
  const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  if (body.includes("No emails found")) {
    return `📭 ${body}`;
  }
  return `📬 Inbox (${query}):\n\n${body}`;
}
