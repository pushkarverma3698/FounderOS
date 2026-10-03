/**
 * FounderOS — Email Reader Tool
 * ==============================
 * Reads Gmail. Provider backend is env-selectable (gws default). Read-only — no HITL.
 *
 * See ADR-029.
 */

import { childLogger } from "../infra/logger.js";
import { getGmailBackend } from "../infra/provider-config.js";
import { providerReadEmails } from "../infra/providers/index.js";
import { listGoogleMailboxes } from "../infra/google-mailboxes.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:email-reader" });

export interface ReadEmailsArgs {
  query?: string;
  max_results?: number;
  account_key?: string;
  department?: string;
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
      account_key: {
        type: "string",
        description: "Which Google account: turicks, personal, naggar, a name added with /login google add, or 'all'.",
      },
    },
    required: [],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const {
      query = "in:inbox",
      max_results = 10,
      account_key,
      department,
    } = input as ReadEmailsArgs;
    const backend = getGmailBackend();
    log.debug({ backend, query, department, account_key }, "read_emails dispatch");
    if (account_key?.trim().toLowerCase() !== "all") {
      return providerReadEmails({ query, max_results, account_key, department });
    }
    // Every mailbox, one labelled section each; an error only when every one failed.
    const names = listGoogleMailboxes();
    const results = await Promise.all(
      names.map(async (n) => [n, await providerReadEmails({ query, max_results, account_key: n, department })] as const),
    );
    const body = results
      .map(([n, r]) => `## ${n}\n${r.success ? (typeof r.data === "string" ? r.data : JSON.stringify(r.data)) : `Error: ${r.error}`}`)
      .join("\n\n");
    return results.some(([, r]) => r.success) ? { success: true, data: body } : { success: false, error: body };
  },
};
