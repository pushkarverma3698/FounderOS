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
  composioLinkedInAnalytics,
  composioLinkedInConnect,
  composioLinkedInPost,
} from "./linkedin-composio.js";
import {
  directLinkedInAnalytics,
  directLinkedInPost,
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
  return getGmailBackend() === "gws" ? gwsReadEmails(input) : composioReadEmails(input);
}

export async function providerSendEmail(input: SendEmailInput): Promise<ToolResult> {
  return getGmailBackend() === "gws" ? gwsSendEmail(input) : composioSendEmail(input);
}

export async function providerCreateCalendarEvent(input: CreateCalendarEventInput): Promise<ToolResult> {
  return getCalendarBackend() === "gws"
    ? gwsCreateCalendarEvent(input)
    : composioCreateCalendarEvent(input);
}

export async function providerLinkedInPost(input: LinkedInPostInput): Promise<ToolResult> {
  return getLinkedInBackend() === "direct"
    ? directLinkedInPost(input)
    : composioLinkedInPost(input);
}

export async function providerLinkedInAnalytics(postId: string): Promise<ToolResult> {
  return getLinkedInBackend() === "direct"
    ? directLinkedInAnalytics(postId)
    : composioLinkedInAnalytics(postId);
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
