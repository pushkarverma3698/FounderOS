/**
 * FounderOS — Google Workspace via gws CLI (direct)
 * ==================================================
 * Primary Google backend. Auth: `gws auth login` on the host (or service-account
 * + domain-wide delegation for Workspace). No Composio middleman.
 */

import { childLogger } from "../logger.js";
import { runGws } from "../gws-runner.js";
import type { ToolResult } from "../../tools/index.js";
import {
  emailFromGwsGet,
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

function listParams(query: string, maxResults: number): string {
  return JSON.stringify({ userId: "me", q: query, maxResults });
}

function getParams(messageId: string): string {
  return JSON.stringify({
    userId: "me",
    id: messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
  });
}

export async function gwsReadEmails(input: ReadEmailsInput, timeoutMs = 30_000): Promise<ToolResult> {
  const listed = await runGws(
    ["gmail", "users", "messages", "list", "--params", listParams(input.query, input.max_results)],
    timeoutMs,
  );
  if (!listed.ok) {
    log.error({ err: listed.error, query: input.query }, "gws Gmail list failed");
    return { success: false, error: `gws Gmail read failed: ${listed.error}` };
  }

  const ids = extractGwsMessageIds(listed.parsed);
  if (ids.length === 0) {
    return { success: true, data: formatEmailList([], input.query, input.max_results) };
  }

  const { messages, error } = await fetchGwsMessages(ids, input.max_results, timeoutMs);
  if (error && messages.length === 0) {
    return { success: false, error: `gws Gmail read failed: ${error}` };
  }

  log.info({ query: input.query, count: messages.length, backend: "gws" }, "Emails read");
  return { success: true, data: formatEmailList(messages, input.query, input.max_results) };
}

export async function gwsSendEmail(input: SendEmailInput, timeoutMs = 30_000): Promise<ToolResult> {
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

  const result = await runGws(args, timeoutMs);
  if (!result.ok) {
    log.error({ err: result.error, to: input.to }, "gws Gmail send failed");
    return { success: false, error: `gws Gmail send failed: ${result.error}` };
  }

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

  const result = await runGws(args, timeoutMs);
  if (!result.ok) {
    log.error({ err: result.error, title: input.title }, "gws Calendar insert failed");
    return { success: false, error: `gws Calendar create failed: ${result.error}` };
  }

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
