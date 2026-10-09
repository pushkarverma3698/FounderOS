/**
 * Callback-button audit
 * =====================
 * Live QA 2026-10-09: a spec card was approved at 09:48:42 and nothing said WHO tapped it. The approval rows carry
 * the decision, not the person. Every button tap now writes one `action_log` row (`callback_tap`) with the Telegram
 * user id and name, the chat, the message the button sat on, the button's data and whether the tap was allowed or
 * refused. The row is keyed on Telegram's callback id, so a redelivered update is one row.
 */
import type { Context } from "grammy";
import { TENANT } from "../core/config.js";
import { writeAuditEntry } from "../db/queries.js";
import { logger } from "../infra/logger.js";
import { COMMAND_CALLBACK_PREFIX } from "./command-dispatch.js";
import { CODING_CALLBACK_PREFIX, MERGE_CALLBACK_PREFIX } from "./merge-digest-callback.js";
import { REPO_CALLBACK_PREFIX } from "./repo-picker.js";
import { RETRY_CALLBACK_PREFIX } from "./retry-button.js";

const log = logger.child({ module: "callback-audit" });

export const CALLBACK_TAP_ACTION = "callback_tap";

/** Buttons whose tap causes a side effect — the founder's alone outside his own chat. Retry re-runs his turn. */
export function isDecisionButton(data: string): boolean {
  const prefixes = ["approve", "reject", REPO_CALLBACK_PREFIX, RETRY_CALLBACK_PREFIX, COMMAND_CALLBACK_PREFIX, MERGE_CALLBACK_PREFIX, CODING_CALLBACK_PREFIX];
  return prefixes.some((p) => data.startsWith(p));
}

/** Who tapped what: the audit row for one callback query. Pure. */
export function callbackTapEntry(ctx: Context, access: string, outcome: "allowed" | "refused") {
  const q = ctx.callbackQuery;
  return {
    tenant_id: TENANT,
    action: CALLBACK_TAP_ACTION,
    idempotency_key: `${CALLBACK_TAP_ACTION}:${q?.id ?? "unknown"}`,
    payload: {
      from_id: ctx.from?.id ?? null,
      from_username: ctx.from?.username ?? null,
      from_name: ctx.from?.first_name ?? null,
      chat_id: ctx.chat?.id ?? null,
      chat_type: ctx.chat?.type ?? null,
      message_id: q?.message?.message_id ?? null,
      data: (q?.data ?? "").slice(0, 64),
      access,
      outcome,
    },
  };
}

/** Record a tap. Never throws: a database blip must not cost the founder his approval. */
export async function auditCallbackTap(ctx: Context, access: string, outcome: "allowed" | "refused"): Promise<void> {
  const entry = callbackTapEntry(ctx, access, outcome);
  log.info({ ...entry.payload }, "Callback tap");
  try {
    await writeAuditEntry(entry);
  } catch (err) {
    // allow-failopen: the tap is logged above; losing the durable row must not block the approval it records.
    log.warn({ err: (err as Error).message }, "Could not write the callback_tap audit row");
  }
}
