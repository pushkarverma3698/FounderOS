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
import { validateBrandVoice, brandFixGuidance, type Channel } from "../../infra/brand-validator.js";
import {
  BRAND_MAX_RETRIES,
  brandRetryKey,
  recordBrandFailure,
  clearBrandRetries,
} from "../../infra/brand-retry.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import type { RunnableConfig } from "@langchain/core/runnables";

const log = childLogger({ module: "agent-tools:comms" });

/**
 * Brand-check with a deterministic convergence cap.
 *
 * - valid draft            → { proceed: true }                  (no banner)
 * - invalid, within cap    → { proceed: false, fix }            (agent re-drafts)
 * - invalid, cap exceeded  → { proceed: true, warning }         (STOP looping;
 *                            gate the closest draft so the founder decides)
 *
 * Bounding it here (not in the prompt) is what stops the 146↔113 oscillation from
 * running to the recursion limit. The count is per-thread+channel and TTL-reset.
 *
 * NOTE on interrupt() re-execution: tool code before the HITL gate runs twice
 * (once to raise interrupt(), once on resume). On the cap-exceeded path the count
 * only ever increases, so the resume re-run still lands on `proceed: true` and the
 * approved send goes through. We therefore clear the count only AFTER the gate.
 */
function brandCheckBounded(
  text: string,
  channel: Channel,
  config: RunnableConfig | undefined,
): { proceed: boolean; fix?: string; warning?: string; retryKey: string } {
  const threadId = config?.configurable?.["thread_id"] as string | undefined;
  const retryKey = brandRetryKey(threadId, channel);

  const brandCheck = validateBrandVoice(text, channel);
  if (brandCheck.valid) return { proceed: true, retryKey };

  const attempt = recordBrandFailure(retryKey);
  if (attempt <= BRAND_MAX_RETRIES) {
    return { proceed: false, retryKey, fix: brandFixGuidance(text, channel) };
  }

  // Cap exceeded — the model is oscillating. Stop re-drafting; surface the closest
  // draft to the founder via HITL with the violations noted, instead of looping.
  log.warn(
    { retryKey, attempt, violations: brandCheck.violations },
    "Brand validation did not converge — gating closest draft after cap",
  );
  return {
    proceed: true,
    retryKey,
    warning: `⚠️ Brand check still flags this after ${BRAND_MAX_RETRIES} fix attempts — approve to send/post as-is, or reject:\n${brandCheck.violations.join("\n")}`,
  };
}

// ── Comms: send email (WRITE — requires approval) ─────────────────────────────

export const sendEmail = tool(
  async ({ to, subject, body }, config) => {
    // Brand voice check with a deterministic retry cap — runs before interrupt()
    // so the HITL card only shows clean content. Within the cap, the agent
    // self-corrects with exact-delta guidance; past the cap we stop looping and
    // gate the closest draft (rule #16 — convergence lives in code, not the prompt).
    const brand = brandCheckBounded(body, "outreach", config);
    if (!brand.proceed) return `Fix these brand violations before sending:\n${brand.fix}`;

    // Pure summary (may run twice) — request approval.
    const rejected = hitlGate({
      action: "send_email",
      title: `📧 Send email to ${to}?`,
      summary: brand.warning ?? `Subject: ${subject}`,
      preview: body,
      args: { to, subject, body },
    });
    if (rejected) {
      clearBrandRetries(brand.retryKey);
      return rejected;
    }
    clearBrandRetries(brand.retryKey);

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
  async ({ text }, config) => {
    // Brand voice check with a deterministic retry cap — runs before interrupt()
    // so the HITL card only shows clean content. Within the cap the agent
    // self-corrects with exact-delta guidance; past the cap we STOP re-drafting
    // (this is what prevents the 146↔113 word-count oscillation from running to
    // the recursion limit) and gate the closest draft with violations noted.
    const brand = brandCheckBounded(text, "linkedin", config);
    if (!brand.proceed) return `Fix these brand violations before posting:\n${brand.fix}`;

    const rejected = hitlGate({
      action: "linkedin_post",
      title: "📣 Publish this LinkedIn post?",
      summary: brand.warning ?? "New LinkedIn post",
      preview: text,
      args: { text },
    });
    if (rejected) {
      clearBrandRetries(brand.retryKey);
      return rejected;
    }
    clearBrandRetries(brand.retryKey);

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
      end_date: z.string().optional().nullable().describe("End date/time (ISO). Defaults to +1 day for all-day or +1h for timed."),
      description: z.string().optional().nullable().describe("Optional description or notes"),
      timezone: z.string().optional().nullable().describe("Timezone (default: Europe/Amsterdam)"),
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
      query: z.string().optional().nullable().describe("Gmail search query (default: 'in:inbox')"),
      limit: z.number().optional().nullable().describe("Max emails to return (default 10)"),
    }),
  },
);
