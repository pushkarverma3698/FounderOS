/**
 * FounderOS v2 — Agent Tools (LangChain-wrapped, HITL-gated)
 * ===========================================================
 * Adapts the real UnifiedTools (src/tools/*) into LangChain `tool()`s that the
 * ReAct sub-agents can call. The KEY fix vs v1: write tools call LangGraph's
 * native `interrupt()` to request the founder's approval, and the SAME tool
 * executes the real action on resume. "Approve → audit log → nothing" is now
 * structurally impossible — the tool IS what runs after approval.
 *
 * Approval contract (read by the Telegram gateway):
 *   interrupt({ kind: "approval", action, title, summary, preview, args })
 *   resume value: "approved" | "rejected"
 *
 * NOTE on interrupt() re-execution semantics:
 *   When interrupt() fires, the tool throws and the graph pauses. On resume the
 *   tool re-runs from the top; interrupt() then RETURNS the resume value. So any
 *   code BEFORE interrupt() runs twice — keep it pure (we only build a summary).
 *   All real side-effects (suppression check, send) happen AFTER interrupt().
 */

import { tool } from "@langchain/core/tools";
import { interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { createHash } from "node:crypto";
import { webSearchTool } from "../tools/web-search.js";
import { emailTool } from "../tools/email.js";
import { readEmailsTool } from "../tools/email-reader.js";
import { githubTool } from "../tools/github.js";
import { linkedinPostTool } from "../tools/linkedin.js";
import { isSuppressed } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "agent-tools" });

/** Single-user tenant for now (column preserved for the future SaaS pivot). */
const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

/** Deterministic idempotency key so the same action never fires twice. */
function idemKey(prefix: string, ...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}:${TENANT}:${h}`;
}

/** Approval payload shape surfaced to the Telegram gateway via interrupt(). */
export interface ApprovalRequest {
  kind: "approval";
  action: string;
  title: string;
  summary: string;
  preview: string;
  args: Record<string, unknown>;
}

// ── Research: web search (read-only, NO approval) ─────────────────────────────

export const searchWeb = tool(
  async ({ query, limit }) => {
    const res = await webSearchTool.execute({ query, limit: limit ?? 5 });
    if (!res.success) {
      return `Web search failed: ${res.error ?? "unknown error"}. (Check that FIRECRAWL_API_KEY is set.)`;
    }
    const results = (res.data as Array<{ title: string; url: string; snippet: string }>) ?? [];
    if (results.length === 0) return `No web results found for "${query}".`;
    return results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");
  },
  {
    name: "search_web",
    description:
      "Search the web for current information, news, or company/market research. Returns titles, URLs, and snippets. Read-only — no approval needed.",
    schema: z.object({
      query: z.string().describe("The search query"),
      limit: z.number().optional().describe("Max results (default 5)"),
    }),
  },
);

// ── Comms: send email (WRITE — requires approval) ─────────────────────────────

export const sendEmail = tool(
  async ({ to, subject, body }) => {
    // Pure summary (may run twice) — request approval.
    const decision = interrupt({
      kind: "approval",
      action: "send_email",
      title: `📧 Send email to ${to}?`,
      summary: `Subject: ${subject}`,
      preview: body,
      args: { to, subject, body },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `Email to ${to} was NOT sent — the founder rejected it.`;
    }

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

// ── Comms: LinkedIn post (WRITE — requires approval) ──────────────────────────

export const linkedinPost = tool(
  async ({ text }) => {
    const decision = interrupt({
      kind: "approval",
      action: "linkedin_post",
      title: "📣 Publish this LinkedIn post?",
      summary: "New LinkedIn post",
      preview: text,
      args: { text },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `LinkedIn post was NOT published — the founder rejected it.`;
    }

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

// ── Engineering: GitHub read (read-only, NO approval) ─────────────────────────

export const githubRead = tool(
  async ({ action, owner, repo }) => {
    const res = await githubTool.execute({ action, ...(owner ? { owner } : {}), ...(repo ? { repo } : {}) });
    if (!res.success) return `GitHub read failed: ${res.error}`;
    return JSON.stringify(res.data, null, 2);
  },
  {
    name: "github_read",
    description:
      "Read from GitHub (no approval needed). Actions: list_repos (optional owner), get_readme (owner+repo), get_stats.",
    schema: z.object({
      action: z.enum(["list_repos", "get_readme", "get_stats"]),
      owner: z.string().optional(),
      repo: z.string().optional(),
    }),
  },
);

// ── Engineering: GitHub write (WRITE — requires approval) ─────────────────────

export const githubWrite = tool(
  async ({ action, owner, repo, title, body, content }) => {
    const decision = interrupt({
      kind: "approval",
      action: `github_${action}`,
      title: `🔧 GitHub ${action} — proceed?`,
      summary: `${action} ${owner ?? ""}${repo ? "/" + repo : ""}${title ? " · " + title : ""}`.trim(),
      preview: content ?? body ?? title ?? "",
      args: { action, owner, repo, title, body, content },
    } satisfies ApprovalRequest) as string;

    if (decision !== "approved") {
      return `GitHub ${action} was NOT done — the founder rejected it.`;
    }

    const res = await githubTool.execute({
      action,
      ...(owner ? { owner } : {}),
      ...(repo ? { repo } : {}),
      ...(title ? { title } : {}),
      ...(body ? { body } : {}),
      ...(content ? { content } : {}),
    });

    if (!res.success) return `GitHub ${action} failed: ${res.error}`;
    return `✅ GitHub ${action} done: ${JSON.stringify(res.data)}`;
  },
  {
    name: "github_write",
    description:
      "Write to GitHub (requires founder approval). Actions: create_issue (owner, repo, title, body), create_repo (title=name, body=description), update_readme (owner, repo, content).",
    schema: z.object({
      action: z.enum(["create_issue", "create_repo", "update_readme"]),
      owner: z.string().optional(),
      repo: z.string().optional(),
      title: z.string().optional(),
      body: z.string().optional(),
      content: z.string().optional(),
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
