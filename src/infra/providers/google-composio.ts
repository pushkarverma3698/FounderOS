/**
 * FounderOS — Google via Composio (legacy fallback)
 * ===================================================
 * Kept behind GMAIL_BACKEND=composio / CALENDAR_BACKEND=composio for rollback.
 * New deployments should use gws (ADR-029).
 */

import { childLogger } from "../logger.js";
import {
  executeComposioAction,
  getComposioApiKey,
  getGCalConnectionId,
  getGCalUserId,
  getGmailConnectionId,
  getGmailUserId,
} from "../composio.js";
import { getComposioAccount } from "../account-registry.js";
import type { ToolResult } from "../../tools/index.js";
import { extractComposioMessages, formatEmailList } from "../../tools/email-messages.js";
import type { CreateCalendarEventInput, ReadEmailsInput, SendEmailInput } from "./types.js";

const log = childLogger({ module: "provider:composio-google" });

async function composioGmailIds(input: { account_key?: string; department?: string }) {
  const { connection, ctx } = await getComposioAccount("google", {
    platform: "google",
    account_key: input.account_key,
    department: input.department,
  });
  return {
    connectionId: connection.connection_id ?? getGmailConnectionId(),
    userId: connection.user_id ?? getGmailUserId(),
    accountKey: ctx.account_key,
  };
}

export function composioGoogleConfigured(): boolean {
  return !!getComposioApiKey();
}

export async function composioReadEmails(input: ReadEmailsInput): Promise<ToolResult> {
  if (!composioGoogleConfigured()) {
    return {
      success: false,
      error: "COMPOSIO_API_KEY not configured. Set GMAIL_BACKEND=gws or add COMPOSIO_API_KEY.",
    };
  }

  try {
    const ids = await composioGmailIds(input);
    const result = (await executeComposioAction(
      "GMAIL_FETCH_EMAILS",
      { query: input.query, max_results: input.max_results, verbose: false },
      ids.connectionId,
      ids.userId,
    )) as Record<string, unknown>;

    const messages = extractComposioMessages(result);
    log.info({ query: input.query, count: messages.length, backend: "composio", account: ids.accountKey }, "Emails read");
    return { success: true, data: formatEmailList(messages, input.query, input.max_results) };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message, query: input.query }, "Composio Gmail read failed");
    return { success: false, error: `Composio Gmail read failed: ${message}` };
  }
}

export async function composioSendEmail(input: SendEmailInput): Promise<ToolResult> {
  if (!composioGoogleConfigured()) {
    return {
      success: false,
      error: "COMPOSIO_API_KEY not configured. Set GMAIL_BACKEND=gws or add COMPOSIO_API_KEY.",
    };
  }

  try {
    const args: Record<string, unknown> = {
      recipient_email: input.to,
      subject: input.subject,
      body: input.body,
    };
    if (input.cc) args["cc"] = input.cc;
    if (input.reply_to) args["reply_to"] = input.reply_to;

    const ids = await composioGmailIds(input);
    const result = await executeComposioAction(
      "GMAIL_SEND_EMAIL",
      args,
      ids.connectionId,
      ids.userId,
    );

    const data = result["data"] as Record<string, unknown> | undefined;
    const messageId = (data?.["id"] ?? result["message_id"]) as string | undefined;

    if (!messageId) {
      const msg = (data?.["message"] ?? "Email send failed — no message id returned") as string;
      log.error({ err: msg, to: input.to }, "Composio Gmail send soft failure");
      return { success: false, error: msg };
    }

    log.info({ message_id: messageId, to: input.to, backend: "composio" }, "Email sent");
    return { success: true, data: { message_id: messageId, to: input.to, subject: input.subject } };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message, to: input.to }, "Composio Gmail send failed");
    return { success: false, error: message };
  }
}

export async function composioCreateCalendarEvent(input: CreateCalendarEventInput): Promise<ToolResult> {
  if (!composioGoogleConfigured()) {
    return {
      success: false,
      error: "COMPOSIO_API_KEY not configured. Set CALENDAR_BACKEND=gws or add COMPOSIO_API_KEY.",
    };
  }

  try {
    const args: Record<string, unknown> = {
      summary: input.title,
      start_datetime: input.start_datetime,
      end_datetime: input.end_datetime,
      timezone: input.timezone,
    };
    if (input.description) args["description"] = input.description;

    const result = await executeComposioAction(
      "GOOGLECALENDAR_CREATE_EVENT",
      args,
      getGCalConnectionId(),
      getGCalUserId(),
    );

    const outer = result["data"] as Record<string, unknown> | undefined;
    const inner = (outer?.["response_data"] ?? outer) as Record<string, unknown> | undefined;
    const eventId = inner?.["id"] as string | undefined;
    const htmlLink = (outer?.["display_url"] ?? inner?.["htmlLink"]) as string | undefined;

    if (!eventId) {
      const msg = (outer?.["message"] ?? "Event creation failed — no event ID returned") as string;
      log.error({ err: msg, title: input.title }, "Composio Calendar soft failure");
      return { success: false, error: msg };
    }

    log.info({ event_id: eventId, title: input.title, backend: "composio" }, "Calendar event created");
    return {
      success: true,
      data: { event_id: eventId, title: input.title, date: input.start_datetime, html_link: htmlLink },
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message, title: input.title }, "Composio Calendar create failed");
    return { success: false, error: message };
  }
}
