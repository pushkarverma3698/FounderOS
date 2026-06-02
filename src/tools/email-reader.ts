/**
 * FounderOS — Email Reader Tool (Composio Gmail-backed)
 * ======================================================
 * Reads emails from Gmail via Composio's GMAIL_LIST_EMAILS action.
 * Read-only — no HITL approval needed.
 *
 * Use cases:
 *  - Check for replies to outreach emails
 *  - Review unread inbox before a call
 *  - Find a specific email by sender or subject
 *
 * Composio action: GMAIL_LIST_EMAILS
 */

import { childLogger } from "../infra/logger.js";
import {
  executeComposioAction,
  getComposioApiKey,
  getGmailConnectionId,
  getGmailUserId,
} from "../infra/composio.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:email-reader" });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReadEmailsArgs {
  query?: string;       // Gmail search query, e.g. "is:unread", "from:alex@acme.com"
  max_results?: number; // max emails to return (default 10)
}

interface EmailMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  messageText?: string;
  messageTimestamp?: string;
  preview?: Record<string, unknown>;
}

// ── Tool: Read Emails ─────────────────────────────────────────────────────────

export const readEmailsTool: UnifiedTool = {
  name: "read_emails",
  description:
    "Read emails from Gmail inbox. Use Gmail search syntax: 'is:unread', 'from:alice@example.com', 'subject:invoice'. Read-only — no approval needed. Returns sender, subject, and snippet for each email.",

  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Gmail search query. Examples: 'is:unread', 'from:alex@acme.com', 'subject:proposal'. Defaults to recent inbox.",
      },
      max_results: {
        type: "number",
        description: "Maximum number of emails to return. Default: 10.",
      },
    },
    required: [],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { query = "in:inbox", max_results = 10 } = input as ReadEmailsArgs;

    if (!getComposioApiKey()) {
      log.warn("COMPOSIO_API_KEY not set — email read skipped");
      return {
        success: false,
        error: "COMPOSIO_API_KEY not configured. Add it to .env to enable Gmail access.",
      };
    }

    try {
      const result = await executeComposioAction(
        "GMAIL_FETCH_EMAILS",
        { query, max_results, verbose: false },
        getGmailConnectionId(),
        getGmailUserId(),
      );

      const data = result["data"] as { messages?: EmailMessage[] } | undefined;
      const messages: EmailMessage[] = data?.messages ?? [];

      if (messages.length === 0) {
        return {
          success: true,
          data: `No emails found matching "${query}". Inbox may be empty or the query returned no results.`,
        };
      }

      const formatted = messages
        .slice(0, max_results)
        .map((m, i) => {
          const from = m.sender ?? "unknown sender";
          const subject = m.subject ?? "(no subject)";
          const body = m.messageText?.slice(0, 200) ?? "";
          const date = m.messageTimestamp ?? "";
          return `${i + 1}. From: ${from}${date ? ` · ${date}` : ""}\n   Subject: ${subject}${body ? `\n   ${body}` : ""}`;
        })
        .join("\n\n");

      log.info({ query, count: messages.length }, "Emails read via agent");
      return { success: true, data: formatted };
    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, query }, "Email read failed");
      return { success: false, error: message };
    }
  },
};
