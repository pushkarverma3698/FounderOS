/**
 * Comms + Marketing department tools.
 *   read_emails           — read-only (no approval)
 *   send_email            — WRITE (HITL-gated) — used by comms, sales, jobhunt
 *   linkedin_post         — WRITE (HITL-gated) — owned by marketing
 *   create_calendar_event — WRITE (HITL-gated) — owned by comms
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { TENANT } from "../../core/config.js";
import { emailTool } from "../../tools/email.js";
import { readEmailsTool } from "../../tools/email-reader.js";
import { linkedinPostTool } from "../../tools/linkedin.js";
import { calendarTool } from "../../tools/calendar.js";
import { isSuppressed } from "../../db/queries.js";
import { validateBrandVoice } from "../../infra/brand-validator.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";

const log = childLogger({ module: "agent-tools:comms" });

// ── Comms: send email (WRITE — requires approval) ─────────────────────────────

export const sendEmail = tool(
  async ({ to, subject, body }) => {
    // Brand voice check — runs before interrupt() so the HITL card only shows
    // clean content. If violations found, agent self-corrects and calls again.
    const brandCheck = validateBrandVoice(body, "outreach");
    if (!brandCheck.valid) {
      return `Fix these brand violations before sending:\n${brandCheck.violations.join("\n")}`;
    }

    // Pure summary (may run twice) — request approval.
    const rejected = hitlGate({
      action: "send_email",
      title: `📧 Send email to ${to}?`,
      summary: `Subject: ${subject}`,
      preview: body,
      args: { to, subject, body },
    });
    if (rejected) return rejected;

    // Side-effects only AFTER approval.
    if (await isSuppressed(TENANT, to)) {
      return `BLOCKED: ${to} is on the do-not-contact list. Email not sent.`;
    }

    const res = await emailTool.execute({
      to,
      subject,
      body,
      idempotency_key: idemKey("email", to, subject, body),
      tenant_id: TENANT,
    });

    if (!res.success) return `Email send failed: ${res.error}`;
    const data = res.data as { skipped?: boolean } | undefined;
    if (data?.skipped) return `This exact email was already sent earlier — not re-sent (idempotency).`;
    log.info({ to }, "Email sent via agent");
    return `✅ Email sent to ${to} (subject: "${subject}").`;
  },
  {
    name: "send_email",
    description:
      "Send an email. The founder is asked to APPROVE before it sends (this is required). Provide recipient, a clear subject, and the full body.",
    schema: z.object({
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject line"),
      body: z.string().describe("Full email body text"),
    }),
  },
);

// ── Marketing: LinkedIn post (WRITE — requires approval) ──────────────────────

export const linkedinPost = tool(
  async ({ text }) => {
    // Brand voice check — runs before interrupt() so the HITL card only shows
    // clean, brand-compliant content. Violations → agent self-corrects.
    const brandCheck = validateBrandVoice(text, "linkedin");
    if (!brandCheck.valid) {
      return `Fix these brand violations before posting:\n${brandCheck.violations.join("\n")}`;
    }

    const rejected = hitlGate({
      action: "linkedin_post",
      title: "📣 Publish this LinkedIn post?",
      summary: "New LinkedIn post",
      preview: text,
      args: { text },
    });
    if (rejected) return rejected;

    const res = await linkedinPostTool.execute({
      text,
      idempotency_key: idemKey("linkedin", text),
      tenant_id: TENANT,
    });

    if (!res.success) return `LinkedIn post failed: ${res.error}`;
    const data = res.data as { skipped?: boolean } | undefined;
    if (data?.skipped) return `This post was already published earlier — not re-posted (idempotency).`;
    return `✅ LinkedIn post published.`;
  },
  {
    name: "linkedin_post",
    description:
      "Publish a post to LinkedIn. The founder is asked to APPROVE before it publishes. Provide the full final post text.",
    schema: z.object({
      text: z.string().describe("The full post text, ready to publish"),
    }),
  },
);

// ── Comms: Google Calendar (WRITE — requires approval) ────────────────────────

export const createCalendarEvent = tool(
  async ({ title, date, end_date, description, timezone }) => {
    const rejected = hitlGate({
      action: "create_calendar_event",
      title: `📅 Add to Google Calendar: "${title}"?`,
      summary: `Date: ${date}${end_date ? ` → ${end_date}` : ""}`,
      preview: description ? `${title}\n${description}` : title,
      args: { title, date, end_date, description, timezone },
    });
    if (rejected) return rejected;

    const res = await calendarTool.execute({
      title,
      date,
      ...(end_date ? { end_date } : {}),
      ...(description ? { description } : {}),
      ...(timezone ? { timezone } : {}),
      // Deterministic key so a resumed/retried run never creates the event twice.
      idempotency_key: idemKey("gcal", title, date),
      tenant_id: TENANT,
    });

    if (!res.success) return `Calendar event creation failed: ${res.error}`;
    const data = res.data as { event_id?: string; title: string; date: string };
    log.info({ title, date }, "Calendar event created via agent");
    return `✅ Calendar event created: "${data.title}" on ${data.date}.`;
  },
  {
    name: "create_calendar_event",
    description:
      "Add an event or reminder to Google Calendar. The founder is asked to APPROVE before creating. Provide title, date (ISO: YYYY-MM-DD for all-day or YYYY-MM-DDTHH:mm:ss for timed), and optional description.",
    schema: z.object({
      title: z.string().describe("Event/reminder title"),
      date: z.string().describe("Start date/time in ISO format: YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:mm:ss"),
      end_date: z.string().optional().describe("End date/time (ISO). Defaults to +1 day for all-day or +1h for timed."),
      description: z.string().optional().describe("Optional description or notes"),
      timezone: z.string().optional().describe("Timezone (default: Europe/Amsterdam)"),
    }),
  },
);

// ── Comms: read emails (read-only, NO approval) ────────────────────────────────

export const readEmails = tool(
  async ({ query, limit }) => {
    const res = await readEmailsTool.execute({ query, max_results: limit ?? 10 });
    if (!res.success) {
      return `Email read failed: ${res.error ?? "unknown error"}. (Check that COMPOSIO_API_KEY is set.)`;
    }
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "read_emails",
    description:
      "Read emails from Gmail inbox. Use Gmail search syntax: 'is:unread', 'from:alice@example.com', 'subject:invoice'. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().optional().describe("Gmail search query (default: 'in:inbox')"),
      limit: z.number().optional().describe("Max emails to return (default 10)"),
    }),
  },
);
