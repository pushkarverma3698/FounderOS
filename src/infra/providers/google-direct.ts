/**
 * FounderOS — Google Workspace via googleapis (service account)
 * =============================================================
 * Unattended Google backend (ADR-029 follow-up). Auth: a Workspace service
 * account with domain-wide delegation, impersonating each account's subject
 * (the mailbox to act as). No interactive `gws auth login`, no CLI binary on
 * the host — "drop the service-account JSON + set the subject, and go".
 *
 * Drop-in for the gws adapter: identical function signatures and ToolResult
 * shapes, so departments, prompts, the capability registry, and the HITL /
 * suppression / brand / judge rails in comms.ts are all untouched.
 */

import { readFileSync } from "node:fs";
import { JWT } from "google-auth-library";
import { gmail } from "@googleapis/gmail";
import { calendar } from "@googleapis/calendar";
import { childLogger } from "../logger.js";
import { getGoogleAccount } from "../account-registry.js";
import {
  emailFromGwsGet,
  formatEmailList,
  type EmailMessage,
} from "../../tools/email-messages.js";
import type { ToolResult } from "../../tools/index.js";
import type {
  CreateCalendarEventInput,
  ReadEmailsInput,
  SendEmailInput,
} from "./types.js";

const log = childLogger({ module: "provider:googleapis" });

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

interface GoogleDirectConfig {
  serviceAccountPath: string;
  subject: string;
  accountKey: string;
}

type ConfigOrError = GoogleDirectConfig | { error: string };

function isError(c: ConfigOrError): c is { error: string } {
  return "error" in c;
}

/**
 * Resolve the service-account JSON path + impersonation subject for the account
 * via the registry. Returns a clear, stage-tagged error (rule #22) when unset —
 * the founder sees exactly which env var to fill, not a generic auth failure.
 */
async function resolveConfig(input: {
  account_key?: string;
  department?: string;
}): Promise<ConfigOrError> {
  const { credentials, ctx } = await getGoogleAccount({
    platform: "google",
    account_key: input.account_key,
    department: input.department,
  });
  const serviceAccountPath = credentials.service_account_path;
  const subject = credentials.impersonate_subject;
  if (!serviceAccountPath) {
    return {
      error:
        "googleapis backend not configured: GOOGLE_APPLICATION_CREDENTIALS (service-account JSON path) is unset",
    };
  }
  if (!subject) {
    return {
      error: `googleapis backend not configured: no impersonation subject for account "${ctx.account_key}" — set GOOGLE_SUBJECT_${ctx.account_key.toUpperCase()} (or GOOGLE_IMPERSONATE_SUBJECT)`,
    };
  }
  return { serviceAccountPath, subject, accountKey: ctx.account_key };
}

/** Build an authorized JWT client impersonating the account's subject. */
async function authorize(cfg: GoogleDirectConfig, scopes: string[]): Promise<JWT> {
  const key = JSON.parse(readFileSync(cfg.serviceAccountPath, "utf8")) as {
    client_email: string;
    private_key: string;
  };
  const client = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes,
    subject: cfg.subject,
  });
  await client.authorize();
  return client;
}

/**
 * Cast boundary. google-auth-library is duplicated in the dependency tree (root
 * + a copy nested under @googleapis/*), so the JWT instance is structurally
 * identical but nominally distinct from the OAuth2Client the gmail()/calendar()
 * constructors expect. The runtime object is fully compatible — cast once here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asAuth = (client: JWT): any => client;

/** RFC 822 message → base64url, as Gmail's `messages.send` requires. */
function buildRawMessage(input: SendEmailInput): string {
  const headers = [
    `To: ${input.to}`,
    input.cc ? `Cc: ${input.cc}` : undefined,
    input.reply_to ? `Reply-To: ${input.reply_to}` : undefined,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter((h): h is string => h !== undefined);
  const message = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(message, "utf8").toString("base64url");
}

export async function directSendEmail(input: SendEmailInput): Promise<ToolResult> {
  const cfg = await resolveConfig(input);
  if (isError(cfg)) return { success: false, error: cfg.error };
  try {
    const auth = await authorize(cfg, [GMAIL_SEND_SCOPE]);
    const client = gmail({ version: "v1", auth: asAuth(auth) });
    const res = await client.users.messages.send({
      userId: "me",
      requestBody: { raw: buildRawMessage(input) },
    });
    const messageId = res.data.id ?? undefined;
    if (!messageId) {
      log.error({ to: input.to }, "googleapis Gmail send soft failure — no message id");
      return { success: false, error: "googleapis Gmail send failed — no message id returned" };
    }
    log.info(
      { message_id: messageId, to: input.to, backend: "googleapis", account: cfg.accountKey },
      "Email sent",
    );
    return { success: true, data: { message_id: messageId, to: input.to, subject: input.subject } };
  } catch (err) {
    log.error({ err: (err as Error).message, to: input.to }, "googleapis Gmail send failed");
    return { success: false, error: `googleapis Gmail send failed: ${(err as Error).message}` };
  }
}

export async function directReadEmails(input: ReadEmailsInput): Promise<ToolResult> {
  const cfg = await resolveConfig(input);
  if (isError(cfg)) return { success: false, error: cfg.error };
  try {
    const auth = await authorize(cfg, [GMAIL_READ_SCOPE]);
    const client = gmail({ version: "v1", auth: asAuth(auth) });
    const listed = await client.users.messages.list({
      userId: "me",
      q: input.query || undefined,
      maxResults: input.max_results,
    });
    const ids = (listed.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      return { success: true, data: formatEmailList([], input.query, input.max_results) };
    }
    const messages: EmailMessage[] = [];
    for (const id of ids.slice(0, input.max_results)) {
      const got = await client.users.messages.get({
        userId: "me",
        id,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });
      messages.push(emailFromGwsGet(got.data as Record<string, unknown>));
    }
    log.info(
      { query: input.query, count: messages.length, backend: "googleapis", account: cfg.accountKey },
      "Emails read",
    );
    return { success: true, data: formatEmailList(messages, input.query, input.max_results) };
  } catch (err) {
    log.error({ err: (err as Error).message, query: input.query }, "googleapis Gmail read failed");
    return { success: false, error: `googleapis Gmail read failed: ${(err as Error).message}` };
  }
}

export async function directCreateCalendarEvent(
  input: CreateCalendarEventInput,
): Promise<ToolResult> {
  const cfg = await resolveConfig(input);
  if (isError(cfg)) return { success: false, error: cfg.error };
  try {
    const auth = await authorize(cfg, [CALENDAR_SCOPE]);
    const client = calendar({ version: "v3", auth: asAuth(auth) });
    const res = await client.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: input.title,
        description: input.description,
        start: { dateTime: input.start_datetime, timeZone: input.timezone },
        end: { dateTime: input.end_datetime, timeZone: input.timezone },
      },
    });
    const eventId = res.data.id ?? undefined;
    if (!eventId) {
      log.error({ title: input.title }, "googleapis Calendar soft failure — no event id");
      return { success: false, error: "googleapis Calendar create failed — no event id returned" };
    }
    log.info({ event_id: eventId, title: input.title, backend: "googleapis" }, "Calendar event created");
    return {
      success: true,
      data: {
        event_id: eventId,
        title: input.title,
        date: input.start_datetime,
        html_link: res.data.htmlLink ?? undefined,
      },
    };
  } catch (err) {
    log.error({ err: (err as Error).message, title: input.title }, "googleapis Calendar create failed");
    return { success: false, error: `googleapis Calendar create failed: ${(err as Error).message}` };
  }
}

/** True when the default account has a service-account path + subject configured. */
export async function googleapisConfigured(): Promise<boolean> {
  const cfg = await resolveConfig({});
  return !isError(cfg);
}
