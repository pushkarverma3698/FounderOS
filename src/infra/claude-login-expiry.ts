/**
 * FounderOS — warn before the server's saved Claude login stops renewing (C-P0-5)
 * =============================================================================
 * The login in ~/.claude/.credentials.json has a refresh token with a known end date (`refreshTokenExpiresAt`). When
 * it passes, a plain `claude` run on the server fails and nobody is told why. This tells the founder 3 days ahead, once
 * per expiry window, with the command that fixes it. Claude only: Google exposes no expiry, so there is none to warn about.
 *
 * ONCE PER WINDOW. The record is a durable action_log row keyed on the expiry timestamp: a restart cannot repeat the
 * warning, and a renewed login (a new timestamp) is a new window. The row is written after the send, so a failed send
 * is tried again on the next daily run. If the row cannot be written the warning may repeat daily: noisy, never silent.
 *
 * NOTHING SECRET. The reader (./claude-token.ts readHostRefreshExpiry) returns a date or a state name; the message and
 * the row carry the date only.
 */

import cron from "node-cron";
import { appTimeZone } from "../core/time.js";
import { TENANT } from "../core/config.js";
import { hasBeenAudited, writeAuditEntry } from "../db/queries.js";
import { childLogger } from "./logger.js";
import { DAY_MS, WARN_AHEAD_MS, readHostRefreshExpiry, type HostExpiryRead } from "./claude-token.js";
import { sendToChat } from "./telegram-send.js";

const log = childLogger({ module: "claude-login-expiry" });

/** Daily 10:15 in the founder's timezone: after the 09:00 standup, clear of the 09:30 job-hunt check. */
export const CLAUDE_EXPIRY_CRON = "15 10 * * *";

export interface ExpiryDeps {
  readonly read: () => Promise<HostExpiryRead>;
  readonly now: () => number;
  readonly send: (text: string) => Promise<void>;
  readonly hasBeenAudited: (key: string) => Promise<boolean>;
  readonly writeAuditEntry: (row: {
    tenant_id: string;
    action: string;
    idempotency_key: string;
    payload: Record<string, unknown>;
  }) => Promise<{ written: boolean }>;
}

export type ExpiryOutcome = "unknown" | "not-due" | "already-warned" | "warned" | "expired" | "send-failed";

const realDeps = (): ExpiryDeps => ({
  read: () => readHostRefreshExpiry(),
  now: Date.now,
  send: (text) => sendToChat(text, "HTML"),
  hasBeenAudited,
  writeAuditEntry,
});

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** One check. Never throws for a read, a send or a record failure: it reports the outcome. */
export async function checkClaudeLoginExpiry(deps: ExpiryDeps = realDeps()): Promise<ExpiryOutcome> {
  const read = await deps.read();
  if (read.state !== "ok") {
    log.warn({ state: read.state }, "Claude login expiry unknown: nothing sent");
    return "unknown";
  }
  const { expiresAtMs } = read;
  const remaining = expiresAtMs - deps.now();
  const expired = remaining <= 0;
  if (!expired && remaining > WARN_AHEAD_MS) return "not-due";

  const action = expired ? "claude_login_expiry_expired" : "claude_login_expiry_warning";
  const key = `${action}:${TENANT}:${expiresAtMs}`;
  if (await deps.hasBeenAudited(key)) return "already-warned";

  const date = isoDay(expiresAtMs);
  const days = Math.ceil(remaining / DAY_MS);
  const text = expired
    ? `The Claude login saved on this server expired on ${date}. A plain claude run on the server cannot renew it. Send /login claude to sign in again.`
    : `The Claude login saved on this server stops renewing on ${date}, in ${days} ${days === 1 ? "day" : "days"}. Send /login claude to renew it before then.`;
  try {
    await deps.send(text);
  } catch (err) {
    // allow-failopen: nothing is recorded, so tomorrow's run sends it again.
    log.warn({ err: (err as Error).message }, "Claude login expiry message could not be sent");
    return "send-failed";
  }
  try {
    const res = await deps.writeAuditEntry({
      tenant_id: TENANT,
      action,
      idempotency_key: key,
      payload: { expires_at: new Date(expiresAtMs).toISOString() },
    });
    if (!res.written) log.warn({ action }, "expiry record already existed");
  } catch (err) {
    // allow-failopen: the message went out; a missing record means a repeat tomorrow, not a lost warning.
    log.warn({ err: (err as Error).message }, "Claude login expiry record could not be written");
  }
  log.info({ action, expires_at: date }, "Claude login expiry message sent");
  return expired ? "expired" : "warned";
}

export function startClaudeLoginExpiryCron(): void {
  const timezone = appTimeZone();
  cron.schedule(
    CLAUDE_EXPIRY_CRON,
    () => {
      checkClaudeLoginExpiry().catch((err) => log.error({ err: (err as Error).message }, "Claude login expiry check failed")); // allow-failopen: a monitoring blip must not reach the bot process
    },
    { timezone },
  );
  log.info({ cron: CLAUDE_EXPIRY_CRON, timezone }, "Claude login expiry check scheduled (daily, warns 3 days ahead)");
}
