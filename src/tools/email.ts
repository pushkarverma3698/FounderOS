/**
 * FounderOS — Email Tool
 * =======================
 * Gmail via Composio SDK.
 * Idempotency: checks audit_log before sending.
 *
 * Phase 1C: Full implementation
 * Phase 1A stub: structure only
 */

import type { UnifiedTool, ToolResult } from "./index.js";

export interface SendEmailArgs {
  to: string;
  subject: string;
  body: string;
  /** Idempotency key — format: email_sent:{thread_id}:{to_hash} */
  idempotency_key: string;
}

export const emailTool: UnifiedTool = {
  name: "send_email",
  description: "Send an email via Gmail. Idempotent — safe to retry.",

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    void args;
    return {
      success: false,
      error: "emailTool: Phase 1C not yet implemented",
    };
  },
};
