/**
 * FounderOS — Provider dispatch layer
 * ====================================
 * Tools call these functions — never Composio or gws directly.
 * Backend selection is env-driven (ADR-029). Swap providers without
 * touching department tools, prompts, or HITL wrappers.
 */

import {
  getCalendarBackend,
  getGmailBackend,
  getLinkedInBackend,
} from "../provider-config.js";
import { getLinkedInAuthorUrn as getComposioAuthorUrn } from "../composio.js";
import {
  composioCreateCalendarEvent,
  composioReadEmails,
  composioSendEmail,
} from "./google-composio.js";
import { gwsCreateCalendarEvent, gwsReadEmails, gwsSendEmail } from "./google-gws.js";
import {
  directCreateCalendarEvent,
  directReadEmails,
  directSendEmail,
} from "./google-direct.js";
import {
  composioLinkedInAnalytics,
  composioLinkedInConnect,
  composioLinkedInPost,
} from "./linkedin-composio.js";
import {
  directLinkedInAnalytics,
  directLinkedInPost,
  directLinkedInReadComments,
  directLinkedInGetMyPosts,
  getLinkedInAuthorUrn as getDirectAuthorUrn,
} from "./linkedin-direct.js";
import type {
  CreateCalendarEventInput,
  LinkedInPostInput,
  ReadEmailsInput,
  SendEmailInput,
} from "./types.js";
import type { ToolResult } from "../../tools/index.js";

/** Author URN for the active LinkedIn backend. */
export function getLinkedInAuthorUrn(): string | undefined {
  return getLinkedInBackend() === "direct" ? getDirectAuthorUrn() : getComposioAuthorUrn();
}
export type {
  CreateCalendarEventInput,
  LinkedInPostInput,
  ReadEmailsInput,
  SendEmailInput,
} from "./types.js";

export async function providerReadEmails(input: ReadEmailsInput): Promise<ToolResult> {
  const backend = getGmailBackend();
  if (backend === "gws") return gwsReadEmails(input);
  if (backend === "googleapis") return directReadEmails(input);
  return composioReadEmails(input);
}

export async function providerSendEmail(input: SendEmailInput): Promise<ToolResult> {
  const backend = getGmailBackend();
  if (backend === "gws") return gwsSendEmail(input);
  if (backend === "googleapis") return directSendEmail(input);
  return composioSendEmail(input);
}

export async function providerCreateCalendarEvent(input: CreateCalendarEventInput): Promise<ToolResult> {
  const backend = getCalendarBackend();
  if (backend === "gws") return gwsCreateCalendarEvent(input);
  if (backend === "googleapis") return directCreateCalendarEvent(input);
  return composioCreateCalendarEvent(input);
}

export async function providerLinkedInPost(input: LinkedInPostInput): Promise<ToolResult> {
  return getLinkedInBackend() === "direct"
    ? directLinkedInPost(input)
    : composioLinkedInPost(input);
}

export async function providerLinkedInAnalytics(
  postId: string,
  opts?: { account_key?: string; department?: string },
): Promise<ToolResult> {
  return getLinkedInBackend() === "direct"
    ? directLinkedInAnalytics(postId, opts)
    : composioLinkedInAnalytics(postId);
}

/** Fetch the author's own recent posts. Direct API only — falls back to action_log in the tool wrapper. */
export async function providerLinkedInGetMyPosts(
  opts?: { limit?: number; account_key?: string; department?: string },
): Promise<ToolResult> {
  return directLinkedInGetMyPosts(opts);
}

/** Read comments on a LinkedIn post. Direct API only — Composio doesn't expose comments endpoint. */
export async function providerLinkedInReadComments(
  postId: string,
  opts?: { limit?: number; account_key?: string; department?: string },
): Promise<ToolResult> {
  return directLinkedInReadComments(postId, opts);
}

export async function providerLinkedInConnect(
  profileUrn: string,
  message: string | undefined,
): Promise<ToolResult> {
  if (getLinkedInBackend() === "direct") {
    return {
      success: false,
      error:
        "LinkedIn connection requests are blocked (ADR-009 ban risk). Not available via direct API.",
    };
  }
  return composioLinkedInConnect(profileUrn, message);
}
