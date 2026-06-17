/**
 * FounderOS — Email Reader Tool (dual backend)
 * =============================================
 * Reads Gmail via Composio (default) or gws CLI (GMAIL_BACKEND=gws).
 * Read-only — no HITL approval needed.
 *
 * See ADR-028 for migration plan.
 */

import { childLogger } from "../infra/logger.js";
import { getGmailBackend } from "../infra/provider-config.js";
import { readEmailsViaComposio } from "./gmail-composio-read.js";
import { readEmailsViaGws } from "./gmail-gws-read.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:email-reader" });

export interface ReadEmailsArgs {
  query?: string;
  max_results?: number;
}

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
    const backend = getGmailBackend();
    log.debug({ backend, query }, "read_emails dispatch");

    const args = { query, max_results };
    if (backend === "gws") {
      return readEmailsViaGws(args);
    }
    return readEmailsViaComposio(args);
  },
};
