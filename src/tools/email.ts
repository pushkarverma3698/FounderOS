/**
 * FounderOS — Email Tool (Composio Gmail-backed)
 * ================================================
 * Sends email via Gmail through Composio's GMAIL_SEND_EMAIL action.
 *
 * Design decisions:
 * - Idempotency-checked via audit_log BEFORE execution (same as linkedin.ts)
 * - HTML body is supported; Composio handles MIME encoding
 * - cc and reply_to are optional; omitted params are not forwarded
 * - tenant_id maps to a Composio entityId (one Gmail OAuth per tenant)
 *
 * Composio action ID: GMAIL_SEND_EMAIL
 *
 * See CLAUDE.md rule #5 (idempotency before external actions)
 */

import { childLogger } from "../infra/logger.js";
import { writeAuditEntry, hasBeenAudited } from "../db/queries.js";
import { executeComposioAction, getComposioApiKey, getGmailConnectionId, getGmailUserId } from "../infra/composio.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:email" });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SendEmailArgs {
  to: string;
  subject: string;
  body: string;
  idempotency_key: string;
  tenant_id: string;
  cc?: string;
  reply_to?: string;
}

// ── Tool: Send Email ──────────────────────────────────────────────────────────

export const emailTool: UnifiedTool = {
  name: "send_email",
  description:
    "Send an email via Gmail (Composio-backed). HTML body supported. Idempotent — safe to retry with the same idempotency_key.",

  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient email address.",
      },
      subject: {
        type: "string",
        description: "Email subject line.",
      },
      body: {
        type: "string",
        description: "Email body. HTML is allowed and will be rendered by most clients.",
      },
      idempotency_key: {
        type: "string",
        description: "Caller-supplied unique key (e.g. 'email:turicks:lead_123:outreach_v1'). Same key will never send twice.",
      },
      tenant_id: {
        type: "string",
        description: "Tenant identifier (e.g. 'turicks'). Maps to a Composio entityId.",
      },
      cc: {
        type: "string",
        description: "Optional CC email address.",
      },
      reply_to: {
        type: "string",
        description: "Optional Reply-To email address.",
      },
    },
    required: ["to", "subject", "body", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { to, subject, body, idempotency_key, tenant_id, cc, reply_to } = input as unknown as SendEmailArgs;

    // Idempotency guard — check BEFORE any external call
    const alreadySent = await hasBeenAudited(idempotency_key);
    if (alreadySent) {
      log.info({ idempotency_key }, "Email already sent — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    if (!getComposioApiKey()) {
      log.warn("COMPOSIO_API_KEY not set — email send skipped");
      return { success: false, error: "COMPOSIO_API_KEY not configured. Add it to .env." };
    }

    try {
      const args: Record<string, unknown> = { recipient_email: to, subject, body };
      if (cc) args["cc"] = cc;
      if (reply_to) args["reply_to"] = reply_to;

      const result = await executeComposioAction(
        "GMAIL_SEND_EMAIL",
        args,
        getGmailConnectionId(),
        getGmailUserId(),
      );

      const data = result["data"] as Record<string, unknown> | undefined;
      const messageId = (data?.["id"] ?? result["message_id"]) as string | undefined;

      // Audit log — prevents duplicate sends
      await writeAuditEntry({
        tenant_id,
        action: "send_email",
        idempotency_key,
        payload: { message_id: messageId, to, subject },
      });

      log.info({ message_id: messageId, to, tenant: tenant_id }, "Email sent successfully");
      return { success: true, data: { message_id: messageId, to, subject } };

    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, idempotency_key, to }, "Email send failed");
      return { success: false, error: message };
    }
  },
};
