/**
 * Comms + Marketing department tools.
 *   read_emails           — read-only (no approval)
 *   send_email            — WRITE (HITL-gated) — used by comms, sales, jobhunt
 *   linkedin_post         — WRITE (HITL-gated) — owned by marketing
 *   create_calendar_event — WRITE (HITL-gated) — owned by comms
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { prepareLinkedInFeedPost } from "../../core/linkedin-posting-policy.js";
import { TENANT, DAILY_EMAIL_LIMIT, DAILY_LINKEDIN_LIMIT } from "../../core/config.js";
import { emailTool } from "../../tools/email.js";
import { readEmailsTool } from "../../tools/email-reader.js";
import { linkedinPostTool, linkedinAnalyticsTool } from "../../tools/linkedin.js";
import { linkedinReadCommentsTool, linkedinGetMyPostsTool } from "../../tools/linkedin-engagement.js";
import { scheduleSocialPostTool } from "../../tools/scheduled-post.js";
import { getCompanyPageMention } from "../../infra/provider-config.js";
import { getRecentLinkedInPostIds, listUpcomingScheduledPosts } from "../../db/queries.js";
import { calendarTool } from "../../tools/calendar.js";
import { hasRecentOutboundToRecipient, isSuppressed, getDailyOutboundCount } from "../../db/queries.js";
import {
  validateBrandVoice,
  brandFixGuidance,
  stripBannedPhrases,
  type Channel,
} from "../../infra/brand-validator.js";
import {
  BRAND_MAX_RETRIES,
  brandRetryKey,
  recordBrandFailure,
  clearBrandRetries,
} from "../../infra/brand-retry.js";
import { judgeOutbound } from "../../infra/judge.js";
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

/**
 * Outbound quality gate = gate 1 (deterministic brand-validator) + gate 2
 * (Claude judge, generator≠critic, rule #6). Gate 2 runs only when gate 1 lets
 * the draft through, and a 'revise' is bounded by the SAME per-thread retry
 * counter so generator+critic together can't loop past BRAND_MAX_RETRIES. The
 * judge is fail-open (infra error → pass) and memoized, so the interrupt()
 * re-execution doesn't fire a second Claude call. Async because gate 2 is an
 * LLM call; HITL remains the final human gate either way.
 */
export async function outboundQualityGate(
  text: string,
  channel: Channel,
  config: RunnableConfig | undefined,
  tool?: string,
): Promise<{ proceed: boolean; fix?: string; warning?: string; retryKey: string }> {
  const brand = brandCheckBounded(text, channel, config);
  if (!brand.proceed) return brand; // brand fix needed — re-draft before the judge

  // §11: pass tool name so identical copy for different tools uses separate cache entries.
  const verdict = await judgeOutbound(text, channel, { tool });
  if (verdict.verdict === "pass") return brand; // clean (may still carry a brand warning)

  const attempt = recordBrandFailure(brand.retryKey);
  if (attempt <= BRAND_MAX_RETRIES) {
    return { proceed: false, retryKey: brand.retryKey, fix: `2nd-pass editor feedback: ${verdict.critique}` };
  }
  // Critic didn't converge either — stop looping, surface the critique on the card.
  return {
    proceed: true,
    retryKey: brand.retryKey,
    warning: `⚠️ 2nd-pass editor still flags this after ${BRAND_MAX_RETRIES} revisions — approve to send/post as-is, or reject:\n${verdict.critique}`,
  };
}

// ── Comms: send email (WRITE — requires approval) ─────────────────────────────

/** Department-bound send_email — routing picks the correct Google account (ADR-036). */
export function createSendEmailTool(department: string) {
  return tool(
    async ({ to, subject, body, account_key }, config) => {
    // G4: Postgres-backed daily send ceiling (enforced before HITL so we don't
    // waste an approval card on a quota-exceeded email). Limit is env-overridable.
    if (DAILY_EMAIL_LIMIT > 0) {
      const todayCount = await getDailyOutboundCount(TENANT, ["send_email"]);
      if (todayCount >= DAILY_EMAIL_LIMIT) {
        log.warn({ todayCount, limit: DAILY_EMAIL_LIMIT }, "Daily email quota reached — send blocked");
        return `Daily email limit reached (${todayCount}/${DAILY_EMAIL_LIMIT} sent today). Try again tomorrow or increase DAILY_EMAIL_LIMIT.`;
      }
    }

    // Brand voice check with a deterministic retry cap — runs before interrupt()
    // so the HITL card only shows clean content. Within the cap, the agent
    // self-corrects with exact-delta guidance; past the cap we stop looping and
    // gate the closest draft (rule #16 — convergence lives in code, not the prompt).
    if (await hasRecentOutboundToRecipient(TENANT, "send_email", to)) {
      return `Already emailed ${to} recently — not re-sent (duplicate outreach guard). Say "force send" with new wording if you truly need a second email.`;
    }

    const brand = await outboundQualityGate(body, "outreach", config, "send_email");
    if (!brand.proceed) return `Revise before sending:\n${brand.fix}`;

    const rejected = await hitlGate({
      action: "send_email",
      title: `📧 Send email to ${to}?`,
      summary: brand.warning ?? `Subject: ${subject}`,
      preview: body,
      args: { to, subject, body },
    }, config);
    if (rejected) {
      clearBrandRetries(brand.retryKey);
      return rejected;
    }
    clearBrandRetries(brand.retryKey);

    if (await isSuppressed(TENANT, to)) {
      return `BLOCKED: ${to} is on the do-not-contact list. Email not sent.`;
    }

    const res = await emailTool.execute({
      to,
      subject,
      body,
      idempotency_key: idemKey("email", to, subject, body),
      tenant_id: TENANT,
      department,
      account_key,
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
      account_key: z
        .string()
        .optional()
        .nullable()
        .describe("Override sending identity: turicks | personal | naggar. Default: department routing."),
    }),
  },
  );
}

/** @deprecated Use createSendEmailTool('comms') — kept for barrel compat. */
export const sendEmail = createSendEmailTool("comms");

// ── Marketing: LinkedIn post (WRITE — requires approval) ──────────────────────

export const linkedinPost = tool(
  async ({ text }, config) => {
    // G4: Postgres-backed daily LinkedIn post ceiling.
    if (DAILY_LINKEDIN_LIMIT > 0) {
      const todayCount = await getDailyOutboundCount(TENANT, ["linkedin_post"]);
      if (todayCount >= DAILY_LINKEDIN_LIMIT) {
        log.warn({ todayCount, limit: DAILY_LINKEDIN_LIMIT }, "Daily LinkedIn quota reached — post blocked");
        return `Daily LinkedIn post limit reached (${todayCount}/${DAILY_LINKEDIN_LIMIT} posted today). Try again tomorrow or increase DAILY_LINKEDIN_LIMIT.`;
      }
    }

    // Brand voice check with a deterministic retry cap — runs before interrupt()
    // so the HITL card only shows clean content. Within the cap the agent
    // self-corrects with exact-delta guidance; past the cap we STOP re-drafting
    // (this is what prevents the 146↔113 word-count oscillation from running to
    // the recursion limit) and gate the closest draft with violations noted.
    let draft = text;
    const userProvided = config?.configurable?.["linkedin_user_provided"] === true;
    let brand = await outboundQualityGate(draft, "linkedin", config, "linkedin_post");
    if (!brand.proceed) {
      const check = validateBrandVoice(draft, "linkedin");
      const onlyBanned = check.violations.every((v) => v.startsWith("found banned phrase"));
      const onlyWordCount = check.violations.every((v) => v.startsWith("word count"));
      if (onlyBanned) {
        draft = stripBannedPhrases(draft);
        brand = {
          proceed: true,
          retryKey: brand.retryKey,
          warning: "Auto-stripped banned phrases — review before posting.",
        };
      } else if (userProvided && onlyWordCount) {
        brand = {
          proceed: true,
          retryKey: brand.retryKey,
          warning: `${check.violations.join("\n")} — founder decides on approval card.`,
        };
      } else {
        return `Revise before posting:\n${brand.fix}`;
      }
    }

    const rejected = await hitlGate({
      action: "linkedin_post",
      title: "📣 Publish this LinkedIn post?",
      summary: brand.warning ?? "New LinkedIn post",
      preview: draft,
      args: { text: draft },
    }, config);
    if (rejected) {
      clearBrandRetries(brand.retryKey);
      return rejected;
    }
    clearBrandRetries(brand.retryKey);

    const { text: publishText, account_key, policy } = prepareLinkedInFeedPost(draft, "immediate_feed");

    const res = await linkedinPostTool.execute({
      text: publishText,
      idempotency_key: idemKey("linkedin", publishText),
      tenant_id: TENANT,
      department: "marketing",
      account_key,
    });

    if (!res.success) return `LinkedIn post failed: ${res.error}`;
    const data = res.data as { skipped?: boolean } | undefined;
    if (data?.skipped) return `This post was already published earlier — not re-posted (idempotency).`;
    return `✅ LinkedIn post published (${policy.rationale}).`;
  },
  {
    name: "linkedin_post",
    description:
      "Publish a post to LinkedIn from the **Turicks company page**. The founder is asked to APPROVE before it publishes. " +
      "For scheduled build-in-public posts (personal profile + @Turicks), use schedule_social_post when available. Provide the full final post text.",
    schema: z.object({
      text: z.string().describe("The full post text, ready to publish"),
    }),
  },
);

// ── Marketing: Scheduled LinkedIn post (WRITE — approved once, auto-published) ─

/**
 * Schedule a LinkedIn post to auto-publish later. LinkedIn's API has no native
 * scheduling, so we persist an approved post and a cron sweep fires it at the
 * chosen time. HITL happens ONCE here (approve content + time); the sweep posts
 * without a second approval. Same brand-validator + judge gate as an immediate
 * post. By default it @tags the Turicks company page (post-from-personal growth
 * play) when LINKEDIN_ORG_URN / LINKEDIN_ORG_NAME are configured.
 */
export const scheduleSocialPost = tool(
  async ({ text, scheduled_at, tag_company_page = true, visibility = "PUBLIC" }, config) => {
    const when = new Date(scheduled_at);
    if (Number.isNaN(when.getTime())) {
      return `I couldn't parse "${scheduled_at}" as a date/time. Give me an ISO 8601 datetime (e.g. 2026-07-12T09:00:00+02:00).`;
    }
    if (when.getTime() <= Date.now()) {
      return `That time (${when.toISOString()}) is in the past — pick a future time.`;
    }

    // Same outbound quality gate as an immediate post (brand-validator + judge,
    // bounded retries). Banned phrases are auto-stripped; other failures re-draft.
    let draft = text;
    let brand = await outboundQualityGate(draft, "linkedin", config, "schedule_social_post");
    if (!brand.proceed) {
      const check = validateBrandVoice(draft, "linkedin");
      const onlyBanned = check.violations.every((v) => v.startsWith("found banned phrase"));
      if (onlyBanned) {
        draft = stripBannedPhrases(draft);
        brand = {
          proceed: true,
          retryKey: brand.retryKey,
          warning: "Auto-stripped banned phrases — review before scheduling.",
        };
      } else {
        return `Revise before scheduling:\n${brand.fix}`;
      }
    }

    const mention = tag_company_page ? getCompanyPageMention() : undefined;
    const tagNote = !tag_company_page
      ? ""
      : mention
        ? `\n\nWill tag: @${mention.name}`
        : "\n\n⚠️ Company-page tag requested but LINKEDIN_ORG_URN / LINKEDIN_ORG_NAME are not set — this will post WITHOUT a tag. Set them to enable @page tagging.";

    const whenLabel = when.toISOString();
    const rejected = await hitlGate(
      {
        action: "schedule_social_post",
        title: "📅 Schedule this LinkedIn post?",
        summary: brand.warning ?? `Publishes automatically at ${whenLabel}`,
        preview: `${draft}\n\n— Scheduled for ${whenLabel} —${tagNote}`,
        args: { text: draft, scheduled_at: whenLabel, tagged: !!mention },
      },
      config,
    );
    if (rejected) {
      clearBrandRetries(brand.retryKey);
      return rejected;
    }
    clearBrandRetries(brand.retryKey);

    const res = await scheduleSocialPostTool.execute({
      text: draft,
      scheduled_at: whenLabel,
      platform: "linkedin",
      visibility,
      mention_urn: mention?.urn,
      mention_name: mention?.name,
      // Time-invariant so an interrupt() resume never queues a duplicate.
      idempotency_key: idemKey("linkedin_sched", draft, whenLabel),
      tenant_id: TENANT,
      department: "marketing",
    });

    if (!res.success) return `Scheduling failed: ${res.error}`;
    const data = res.data as { scheduled_at: string; tagged: boolean };
    return `✅ LinkedIn post scheduled for ${data.scheduled_at}${data.tagged ? ` (tagging @${mention?.name})` : ""}. I'll publish it automatically and confirm here.`;
  },
  {
    name: "schedule_social_post",
    description:
      "Schedule a LinkedIn post to auto-publish at a future time. The founder APPROVES once now (an Approve/Reject card); it then posts automatically at the scheduled time — no second approval. Provide the full final text and an ISO 8601 datetime. By default it @tags the Turicks company page.",
    schema: z.object({
      text: z.string().describe("The full, final post text, ready to publish"),
      scheduled_at: z
        .string()
        .describe("ISO 8601 datetime to publish at, e.g. 2026-07-12T09:00:00+02:00 (must be future)"),
      tag_company_page: z
        .boolean()
        .optional()
        .nullable()
        .describe("Tag the Turicks company page in the post. Default: true."),
      visibility: z
        .enum(["PUBLIC", "CONNECTIONS"])
        .optional()
        .nullable()
        .describe("Post visibility. Default: PUBLIC."),
    }),
  },
);

/** List upcoming scheduled posts — read-only, no approval. */
export const listScheduledPosts = tool(
  async () => {
    const rows = await listUpcomingScheduledPosts(TENANT, 10);
    if (!rows.length) return "No scheduled posts in the queue.";
    const lines = rows.map((r, i) => {
      const when = r.scheduled_at instanceof Date ? r.scheduled_at.toISOString() : String(r.scheduled_at);
      const tag = r.mention_name ? ` @${r.mention_name}` : "";
      return `${i + 1}. ${when} — "${r.text.slice(0, 60)}${r.text.length > 60 ? "…" : ""}"${tag}`;
    });
    return `📅 Upcoming scheduled posts:\n\n${lines.join("\n")}`;
  },
  {
    name: "list_scheduled_posts",
    description: "List upcoming scheduled social posts and their publish times. Read-only — no approval needed.",
    schema: z.object({}),
  },
);

// ── Comms: Google Calendar (WRITE — requires approval) ────────────────────────

export const createCalendarEvent = tool(
  async ({ title, date, end_date, description, timezone }, config) => {
    const rejected = await hitlGate({
      action: "create_calendar_event",
      title: `📅 Add to Google Calendar: "${title}"?`,
      summary: `Date: ${date}${end_date ? ` → ${end_date}` : ""}`,
      preview: description ? `${title}\n${description}` : title,
      args: { title, date, end_date, description, timezone },
    }, config);
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
      department: "comms",
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

// ── Marketing: LinkedIn engagement assist (safe-assist, ADR-009 Option D) ──────
// These tools NEVER auto-send. They surface drafts via HITL cards for copy-paste.

/** Get the author's own recent LinkedIn post IDs — read-only, no approval needed.
 *  Falls back to FounderOS action_log if r_member_social scope is absent. */
export const linkedinGetMyPosts = tool(
  async ({ limit = 5 }) => {
    const res = await linkedinGetMyPostsTool.execute({ limit });
    if (res.success) {
      const data = res.data as { posts: Array<{ id: string; text: string; created_at: number }> };
      if (!data.posts.length) return "No recent LinkedIn posts found via API.";
      const lines = data.posts.map(
        (p, i) => `${i + 1}. ${p.id}${p.text ? ` — "${p.text.slice(0, 80)}${p.text.length > 80 ? "…" : ""}"` : ""}`,
      );
      return `Your recent LinkedIn posts:\n\n${lines.join("\n")}`;
    }

    // API failed (likely missing r_member_social scope) — fall back to action_log
    const postIds = await getRecentLinkedInPostIds(TENANT, 30);
    if (!postIds.length) {
      return (
        "No recent LinkedIn posts found. Either post via FounderOS first (so I can track the IDs) " +
        "or add r_member_social scope to your LinkedIn Developer App and re-authorize."
      );
    }
    const lines = postIds.map((id, i) => `${i + 1}. ${id}`);
    return (
      `Your recent LinkedIn posts (from FounderOS audit log):\n\n${lines.join("\n")}\n\n` +
      `Note: ${res.error ?? "LinkedIn API scope not available — use any ID above with linkedin_read_comments."}`
    );
  },
  {
    name: "linkedin_get_my_posts",
    description:
      "Get your own recent LinkedIn post IDs. Call this when no post_id is given for comment reading. " +
      "Falls back to FounderOS audit log if LinkedIn API scope is absent. Read-only — no approval needed.",
    schema: z.object({
      limit: z.number().optional().nullable().describe("Max posts to return (default 5)"),
    }),
  },
);

/** Fetch engagement analytics for a LinkedIn post — read-only, no approval. */
export const linkedinAnalytics = tool(
  async ({ post_id }) => {
    const res = await linkedinAnalyticsTool.execute({ post_id, tenant_id: TENANT });
    if (!res.success) {
      return `LinkedIn analytics failed: ${res.error ?? "unknown error"}`;
    }
    const data = res.data as Record<string, unknown> | undefined;
    if (!data) return "No analytics data returned.";
    const lines = Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `- ${k}: ${String(v)}`);
    return lines.length
      ? `📊 Post analytics (${post_id}):\n${lines.join("\n")}`
      : `Analytics returned for ${post_id} but no metrics parsed — raw scopes may be limited.`;
  },
  {
    name: "linkedin_analytics",
    description:
      "Fetch engagement metrics for a LinkedIn post (impressions, reactions, comments). " +
      "Call linkedin_get_my_posts first if you need post IDs. Read-only — use before drafting the next post to learn what worked.",
    schema: z.object({
      post_id: z.string().describe("LinkedIn post URN or ID from linkedin_get_my_posts or action_log"),
    }),
  },
);

/** Read comments on your LinkedIn posts — read-only, no approval needed. */
export const linkedinReadComments = tool(
  async ({ post_id, limit }) => {
    const res = await linkedinReadCommentsTool.execute({ post_id, limit });
    if (!res.success) {
      return `LinkedIn comment read failed: ${res.error ?? "unknown error"}`;
    }
    const data = res.data as {
      comments: Array<{ id: string; author_urn: string; text: string; created_at: number }>;
      total: number;
    };
    if (!data.comments.length) return `No comments found on post ${post_id}.`;

    const lines = data.comments.map(
      (c, i) =>
        `${i + 1}. ${c.author_urn}\n   "${c.text}"`,
    );
    return `📬 ${data.total} comment(s) on post:\n\n${lines.join("\n\n")}`;
  },
  {
    name: "linkedin_read_comments",
    description:
      "Read comments on one of your LinkedIn posts. Returns commenter URN + text. " +
      "Read-only — no approval needed. Requires r_member_social OAuth scope.",
    schema: z.object({
      post_id: z.string().describe("LinkedIn post URN (e.g. urn:li:share:123456789)"),
      limit: z.number().optional().nullable().describe("Max comments to return (default 20)"),
    }),
  },
);

/** Draft a reply to a LinkedIn comment — HITL card, copy-paste on approval, no auto-send. */
export const draftLinkedInReply = tool(
  async ({ comment_author, comment_text, reply_text }, config) => {
    const preview =
      `Reply to: ${comment_author}\n` +
      `Their comment: "${comment_text.slice(0, 150)}${comment_text.length > 150 ? "…" : ""}"\n\n` +
      `— Your reply —\n${reply_text}`;

    const rejected = await hitlGate(
      {
        action: "draft_linkedin_reply",
        title: `💬 LinkedIn reply to ${comment_author}?`,
        summary: "Review — copy-paste to LinkedIn after approving. No auto-send.",
        preview,
        args: { comment_author, comment_text, reply_text },
      },
      config,
    );
    if (rejected) return rejected;

    log.info({ comment_author }, "LinkedIn reply draft approved for copy-paste");
    return `✅ Reply approved. Copy this into LinkedIn:\n\n${reply_text}`;
  },
  {
    name: "draft_linkedin_reply",
    description:
      "Draft a reply to a LinkedIn comment. Shows an Approve/Reject HITL card — on approval returns the text for you to copy-paste manually. No auto-send.",
    schema: z.object({
      comment_author: z.string().describe("Name or URN of the commenter"),
      comment_text: z.string().describe("The original comment text you are replying to"),
      reply_text: z
        .string()
        .describe("Your reply — conversational, ≤300 chars ideally. No banned phrases."),
    }),
  },
);

/** Draft a LinkedIn connection note + DM opener — HITL card, copy-paste on approval, ADR-009. */
export const draftConnectionNote = tool(
  async ({ profile_name, profile_context, connect_note, dm_opener }, config) => {
    const notePreview =
      `Target: ${profile_name}\n` +
      `Why connect: ${profile_context}\n\n` +
      `— Connect note (≤300 chars) —\n${connect_note}` +
      (dm_opener ? `\n\n— DM opener (after they accept) —\n${dm_opener}` : "");

    const rejected = await hitlGate(
      {
        action: "draft_connection_note",
        title: `🤝 LinkedIn outreach to ${profile_name}?`,
        summary: "Review — copy-paste to LinkedIn manually. No auto-send (ADR-009 Option D).",
        preview: notePreview,
        args: { profile_name, profile_context, connect_note, dm_opener },
      },
      config,
    );
    if (rejected) return rejected;

    log.info({ profile_name }, "Connection note draft approved for copy-paste");
    const lines = [
      `✅ Outreach draft for ${profile_name} approved. Paste into LinkedIn:`,
      ``,
      `📋 Connect note:`,
      connect_note,
    ];
    if (dm_opener) {
      lines.push(``, `📩 DM opener (send after they accept):`, dm_opener);
    }
    return lines.join("\n");
  },
  {
    name: "draft_connection_note",
    description:
      "Draft a LinkedIn connection note + optional DM opener for a target profile. " +
      "Approve/Reject HITL card — on approval returns text for copy-paste. No auto-send (ADR-009 Option D).",
    schema: z.object({
      profile_name: z.string().describe("Full name of the person to connect with"),
      profile_context: z
        .string()
        .describe("Why connect? Role, company, shared context — used to personalise the note"),
      connect_note: z
        .string()
        .describe("Connection request note — max 300 chars, specific, no banned phrases"),
      dm_opener: z
        .string()
        .optional()
        .nullable()
        .describe("Optional first DM to send after they accept the connection"),
    }),
  },
);

// ── Comms: read emails (read-only, NO approval) ────────────────────────────────

export const readEmails = tool(
  async ({ query, limit }) => {
    const res = await readEmailsTool.execute({
      query,
      max_results: limit ?? 10,
      department: "comms",
    });
    if (!res.success) {
      return `Email read failed: ${res.error ?? "unknown error"}. (Check gws auth or GMAIL_BACKEND=composio rollback.)`;
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
