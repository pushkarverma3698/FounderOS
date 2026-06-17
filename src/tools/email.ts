/**
 * FounderOS — Email Tool
 * =======================
 * Sends email via Gmail. Provider backend is env-selectable (gws default).
 * HITL + idempotency enforced here; provider layer handles transport only.
 *
 * See ADR-029 (direct platform integrations).
 */

import { childLogger } from "../infra/logger.js";
import { writeAuditEntry, hasBeenAudited } from "../db/queries.js";
import { providerSendEmail } from "../infra/providers/index.js";
import { getGmailBackend } from "../infra/provider-config.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:email" });

export interface SendEmailArgs {
  to: string;
  subject: string;
  body: string;
  idempotency_key: string;
  tenant_id: string;
  cc?: string;
  reply_to?: string;
}

export const emailTool: UnifiedTool = {
  name: "send_email",
  description:
    "Send an email via Gmail. HTML body supported. Idempotent — safe to retry with the same idempotency_key.",

  input_schema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient email address." },
      subject: { type: "string", description: "Email subject line." },
      body: {
        type: "string",
        description: "Email body. HTML is allowed and will be rendered by most clients.",
      },
      idempotency_key: {
        type: "string",
        description:
          "Caller-supplied unique key (e.g. 'email:turicks:lead_123:outreach_v1'). Same key will never send twice.",
      },
      tenant_id: { type: "string", description: "Tenant identifier (e.g. 'turicks')." },
      cc: { type: "string", description: "Optional CC email address." },
      reply_to: { type: "string", description: "Optional Reply-To email address." },
    },
    required: ["to", "subject", "body", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { to, subject, body, idempotency_key, tenant_id, cc, reply_to } = input as unknown as SendEmailArgs;

    const alreadySent = await hasBeenAudited(idempotency_key);
    if (alreadySent) {
      log.info({ idempotency_key }, "Email already sent — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    const result = await providerSendEmail({ to, subject, body, cc, reply_to });
    if (!result.success) {
      return result;
    }

    const data = result.data as Record<string, unknown> | undefined;
    const messageId = data?.["message_id"] as string | undefined;
    if (!messageId) {
      return { success: false, error: "Email send failed — provider returned no message id" };
    }

    await writeAuditEntry({
      tenant_id,
      action: "send_email",
      idempotency_key,
      payload: { message_id: messageId, to, subject, backend: getGmailBackend() },
    });

    log.info({ message_id: messageId, to, tenant: tenant_id }, "Email sent successfully");
    return { success: true, data: { message_id: messageId, to, subject } };
  },
};
