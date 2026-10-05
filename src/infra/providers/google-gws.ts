/**
 * FounderOS — Google Workspace via gws CLI (direct)
 * ==================================================
 * Primary Google backend. Auth: `gws auth login` on the host (or service-account
 * + domain-wide delegation for Workspace). No third-party middleman.
 */

import { childLogger } from "../logger.js";
import { runGws } from "../gws-runner.js";
import { getGoogleAccount } from "../account-registry.js";
import { addedMailboxDir } from "../google-mailboxes.js";
import { isAccountKey } from "../../core/accounts.js";
import { alertOnCredentialFailure, clearCredentialAlert } from "../provider-probes.js";
import type { ToolResult } from "../../tools/index.js";
import {
  extractGwsMessageIds,
  formatEmailList,
} from "../../tools/email-messages.js";
import { fetchGwsMessages } from "../../tools/gmail-gws-read.js";
import type {
  CreateCalendarEventInput,
  ReadEmailsInput,
  SendEmailInput,
} from "./types.js";

const log = childLogger({ module: "provider:gws" });

/**
 * AG-014: shown instead of the raw gws error when the failure is a dead/revoked
 * grant. A raw `invalid_grant` string read like a parsing defect to anything
 * downstream (the model, a retry loop) — this names what it actually is and
 * that retrying will not help. The founder has separately been alerted by
 * `alertOnCredentialFailure` (provider-probes.ts).
 */
const GOOGLE_REAUTH_ERROR =
  "Google account needs re-authorization — the refresh token was revoked or expired. This will " +
  "not resolve on retry; the founder has been notified and must re-authorize manually.";

/** An added mailbox (`/login google add`) has only its folder; an unknown name is an error, not another inbox. */
async function gwsOpts(
  input: { account_key?: string; department?: string },
): Promise<{ gwsProfileDir: string; accountKey: string } | { error: string }> {
  const explicit = input.account_key?.trim().toLowerCase();
  if (explicit && !isAccountKey(explicit)) {
    const added = addedMailboxDir(explicit);
    return "error" in added ? added : { gwsProfileDir: added.dir, accountKey: explicit };
  }
  const { credentials, ctx } = await getGoogleAccount({
    platform: "google",
    account_key: input.account_key,
    department: input.department,
  });
  return { gwsProfileDir: credentials.gws_profile_dir, accountKey: ctx.account_key };
}

function listParams(query: string, maxResults: number): string {
  return JSON.stringify({ userId: "me", q: query, maxResults });
}

/**
 * `notify` is the credential-failure alert sink. The bot leaves it unset (the
 * founder hears about a dead grant once per episode); the MCP hub passes a silent
 * one, because every coding-tool session is a new hub process with its own
 * episode memory and would otherwise re-alert on every session.
 */
export async function gwsReadEmails(
  input: ReadEmailsInput,
  timeoutMs = 30_000,
  notify?: (html: string) => Promise<void>,
): Promise<ToolResult> {
  const opts = await gwsOpts(input);
  if ("error" in opts) return { success: false, error: opts.error };
  const listed = await runGws(
    ["gmail", "users", "messages", "list", "--params", listParams(input.query, input.max_results)],
    timeoutMs,
    { gwsProfileDir: opts.gwsProfileDir },
  );
  if (!listed.ok) {
    log.error({ err: listed.error, query: input.query }, "gws Gmail list failed");
    if (await alertOnCredentialFailure("active_gmail", listed.error, notify, opts.accountKey)) {
      return { success: false, error: GOOGLE_REAUTH_ERROR };
    }
    return { success: false, error: `gws Gmail read failed: ${listed.error}` };
  }
  clearCredentialAlert("active_gmail", opts.accountKey);

  const ids = extractGwsMessageIds(listed.parsed);
  if (ids.length === 0) {
    return { success: true, data: formatEmailList([], input.query, input.max_results) };
  }

  const { messages, error } = await fetchGwsMessages(ids, input.max_results, timeoutMs, opts.gwsProfileDir);
  if (error && messages.length === 0) {
    return { success: false, error: `gws Gmail read failed: ${error}` };
  }

  log.info({ query: input.query, count: messages.length, backend: "gws", account: opts.accountKey }, "Emails read");
  return { success: true, data: formatEmailList(messages, input.query, input.max_results) };
}

export async function gwsSendEmail(input: SendEmailInput, timeoutMs = 30_000): Promise<ToolResult> {
  const opts = await gwsOpts(input);
  if ("error" in opts) return { success: false, error: opts.error };
  const args = [
    "gmail",
    "+send",
    "--to",
    input.to,
    "--subject",
    input.subject,
    "--body",
    input.body,
  ];
  if (input.cc) args.push("--cc", input.cc);

  const result = await runGws(args, timeoutMs, { gwsProfileDir: opts.gwsProfileDir });
  if (!result.ok) {
    log.error({ err: result.error, to: input.to }, "gws Gmail send failed");
    if (await alertOnCredentialFailure("active_gmail", result.error, undefined, opts.accountKey)) {
      return { success: false, error: GOOGLE_REAUTH_ERROR };
    }
    return { success: false, error: `gws Gmail send failed: ${result.error}` };
  }
  clearCredentialAlert("active_gmail", opts.accountKey);

  const parsed = result.parsed;
  const messageId = extractGwsMessageId(parsed);
  if (!messageId) {
    const msg = extractGwsErrorMessage(parsed) ?? "gws Gmail send failed — no message id returned";
    log.error({ err: msg, to: input.to }, "gws Gmail send soft failure");
    return { success: false, error: msg };
  }

  log.info({ message_id: messageId, to: input.to, backend: "gws" }, "Email sent");
  return { success: true, data: { message_id: messageId, to: input.to, subject: input.subject } };
}

export async function gwsCreateCalendarEvent(
  input: CreateCalendarEventInput,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const opts = await gwsOpts(input);
  if ("error" in opts) return { success: false, error: opts.error };
  const args = [
    "calendar",
    "+insert",
    "--summary",
    input.title,
    "--start",
    input.start_datetime,
    "--end",
    input.end_datetime,
  ];
  if (input.description) args.push("--description", input.description);
  if (input.timezone) args.push("--timezone", input.timezone);

  const result = await runGws(args, timeoutMs, { gwsProfileDir: opts.gwsProfileDir });
  if (!result.ok) {
    log.error({ err: result.error, title: input.title }, "gws Calendar insert failed");
    if (await alertOnCredentialFailure("active_calendar", result.error, undefined, opts.accountKey)) {
      return { success: false, error: GOOGLE_REAUTH_ERROR };
    }
    return { success: false, error: `gws Calendar create failed: ${result.error}` };
  }
  clearCredentialAlert("active_calendar", opts.accountKey);

  const eventId = extractGwsEventId(result.parsed);
  if (!eventId) {
    const msg = extractGwsErrorMessage(result.parsed) ?? "gws Calendar create failed — no event id returned";
    log.error({ err: msg, title: input.title }, "gws Calendar soft failure");
    return { success: false, error: msg };
  }

  const htmlLink = extractGwsEventLink(result.parsed);
  log.info({ event_id: eventId, title: input.title, backend: "gws" }, "Calendar event created");
  return {
    success: true,
    data: { event_id: eventId, title: input.title, date: input.start_datetime, html_link: htmlLink },
  };
}

export interface ListCalendarEventsInput {
  account_key?: string;
  /** RFC 3339 window. */
  time_min: string;
  time_max: string;
  max_results: number;
}

/** Read-only: events on the account's primary calendar in [time_min, time_max). */
export async function gwsListCalendarEvents(
  input: ListCalendarEventsInput,
  timeoutMs = 30_000,
  notify?: (html: string) => Promise<void>,
): Promise<ToolResult> {
  const opts = await gwsOpts(input);
  if ("error" in opts) return { success: false, error: opts.error };
  const params = {
    calendarId: "primary",
    timeMin: input.time_min,
    timeMax: input.time_max,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: input.max_results,
  };
  const result = await runGws(["calendar", "events", "list", "--params", JSON.stringify(params)], timeoutMs, {
    gwsProfileDir: opts.gwsProfileDir,
  });
  if (!result.ok) {
    log.error({ err: result.error }, "gws Calendar list failed");
    if (await alertOnCredentialFailure("active_calendar", result.error, notify, opts.accountKey)) {
      return { success: false, error: GOOGLE_REAUTH_ERROR };
    }
    return { success: false, error: `gws Calendar read failed: ${result.error}` };
  }
  clearCredentialAlert("active_calendar", opts.accountKey);
  return { success: true, data: formatCalendarEvents(result.parsed) };
}

/** One line per event: start – end · title · location/meeting link. Pure. */
export function formatCalendarEvents(parsed: unknown): string {
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const data = (root["data"] ?? root) as Record<string, unknown>;
  const items = Array.isArray(data["items"]) ? (data["items"] as Array<Record<string, unknown>>) : [];
  if (items.length === 0) return "No events in this window.";
  const when = (v: unknown): string => {
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    return String(o["dateTime"] ?? o["date"] ?? "?");
  };
  return items
    .map((e) => {
      const where = e["location"] ?? e["hangoutLink"];
      return `${when(e["start"])} – ${when(e["end"])} · ${String(e["summary"] ?? "(no title)")}${where ? ` · ${String(where)}` : ""}`;
    })
    .join("\n");
}

/** Extract message id from gws +send JSON response. */
function extractGwsMessageId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const data = (obj["data"] ?? obj) as Record<string, unknown>;
  const id = data["id"] ?? data["messageId"] ?? data["message_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Extract event id from gws calendar +insert JSON response. */
function extractGwsEventId(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const data = (obj["data"] ?? obj) as Record<string, unknown>;
  const id = data["id"] ?? data["eventId"] ?? data["event_id"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function extractGwsEventLink(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const data = (obj["data"] ?? obj) as Record<string, unknown>;
  const link = data["htmlLink"] ?? data["html_link"] ?? data["link"];
  return typeof link === "string" ? link : undefined;
}

function extractGwsErrorMessage(parsed: unknown): string | undefined {
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  const data = (obj["data"] ?? obj) as Record<string, unknown>;
  const err = data["error"] ?? data["message"] ?? obj["error"];
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return undefined;
}
