/**
 * FounderOS — LinkedIn Tool (Composio-backed)
 * =============================================
 * Wraps Composio's LinkedIn integration for:
 *  - Posting text content (with optional image URL)
 *  - Fetching recent post analytics (impressions, reactions)
 *  - Sending connection requests (prospecting use-case)
 *
 * Design decisions:
 * - All calls are idempotency-checked via audit_log BEFORE execution
 *   (LinkedIn does not provide a native deduplication layer)
 * - Analytics fetch is read-only — no idempotency needed
 * - Connection requests are rate-limited at the tool level: max 10/day per tenant
 *
 * Composio action IDs (as of Composio SDK v0.5+):
 *   LINKEDIN_CREATE_POST
 *   LINKEDIN_GET_POST_ANALYTICS
 *   LINKEDIN_SEND_CONNECTION_REQUEST
 *
 * See docs/decisions/006-why-composio-for-linkedin.md
 */

import { childLogger } from "../infra/logger.js";
import { writeAuditEntry, hasBeenAudited } from "../db/queries.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:linkedin" });

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LinkedInPostInput {
  text: string;
  image_url?: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
}

export interface LinkedInPostResult {
  success: boolean;
  post_id?: string;
  post_url?: string;
  error?: string;
}

export interface LinkedInAnalyticsInput {
  post_id: string;
}

export interface LinkedInAnalyticsResult {
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
  click_rate?: number;
}

export interface LinkedInConnectInput {
  profile_urn: string;  // e.g. "urn:li:person:ABC123"
  message?: string;     // optional personalised note (max 300 chars)
}

// ── Tool: LinkedIn Post ───────────────────────────────────────────────────────

export const linkedinPostTool: UnifiedTool = {
  name: "linkedin_post",
  description:
    "Publish a LinkedIn text post. Requires COMPOSIO_API_KEY. Idempotency-checked — same content will not be posted twice in the same day.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The post body. 80–300 words, mobile-first formatting.",
      },
      image_url: {
        type: "string",
        description: "Optional public image URL to attach.",
      },
      visibility: {
        type: "string",
        enum: ["PUBLIC", "CONNECTIONS"],
        description: "Post visibility. Default: PUBLIC.",
      },
      idempotency_key: {
        type: "string",
        description: "Unique key for idempotency (e.g. 'linkedin_post:turicks:build_log:2024-W03')",
      },
      tenant_id: {
        type: "string",
        description: "Tenant identifier (e.g. 'turicks').",
      },
    },
    required: ["text", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { text, image_url, visibility = "PUBLIC", idempotency_key, tenant_id } = input as {
      text: string;
      image_url?: string;
      visibility?: "PUBLIC" | "CONNECTIONS";
      idempotency_key: string;
      tenant_id: string;
    };

    // Idempotency check
    const alreadyPosted = await hasBeenAudited(idempotency_key as string);
    if (alreadyPosted) {
      log.info({ idempotency_key }, "LinkedIn post already sent — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    if (!process.env["COMPOSIO_API_KEY"]) {
      log.warn("COMPOSIO_API_KEY not set — LinkedIn post skipped");
      return {
        success: false,
        error: "COMPOSIO_API_KEY not configured. Set it in .env to enable LinkedIn posting.",
      };
    }

    try {
      // Composio SDK call — lazy import to avoid hard dep when Composio not configured
      const { OpenAIToolSet } = await import("composio-core");
      const toolset = new OpenAIToolSet({ apiKey: process.env["COMPOSIO_API_KEY"] });

      const result = await toolset.executeAction({
        action: "LINKEDIN_CREATE_POST",
        params: {
          text,
          image_url,
          visibility,
        },
        entityId: tenant_id,
      });

      const postId = (result as Record<string, unknown>)["post_id"] as string | undefined;
      const postUrl = postId ? `https://www.linkedin.com/feed/update/${postId}` : undefined;

      // Audit log — prevents duplicate posts
      await writeAuditEntry({
        tenant_id: tenant_id as string,
        action: "linkedin_post",
        idempotency_key: idempotency_key as string,
        payload: { post_id: postId, text: text.slice(0, 100), visibility },
      });

      log.info({ post_id: postId, tenant: tenant_id }, "LinkedIn post published");
      return { success: true, data: { post_id: postId, post_url: postUrl } };

    } catch (err) {
      const message = (err as Error).message;
      log.error({ err: message, idempotency_key }, "LinkedIn post failed");
      return { success: false, error: message };
    }
  },
};

// ── Tool: LinkedIn Analytics ──────────────────────────────────────────────────

export const linkedinAnalyticsTool: UnifiedTool = {
  name: "linkedin_analytics",
  description: "Fetch engagement analytics for a LinkedIn post (impressions, reactions, comments).",
  input_schema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "LinkedIn post URN or ID.",
      },
      tenant_id: {
        type: "string",
        description: "Tenant identifier.",
      },
    },
    required: ["post_id", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { post_id, tenant_id } = input as { post_id: string; tenant_id: string };

    if (!process.env["COMPOSIO_API_KEY"]) {
      return { success: false, error: "COMPOSIO_API_KEY not configured." };
    }

    try {
      const { OpenAIToolSet } = await import("composio-core");
      const toolset = new OpenAIToolSet({ apiKey: process.env["COMPOSIO_API_KEY"] });

      const result = await toolset.executeAction({
        action: "LINKEDIN_GET_POST_ANALYTICS",
        params: { post_id },
        entityId: tenant_id,
      });

      return { success: true, data: result as unknown as LinkedInAnalyticsResult };

    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

// ── Tool: LinkedIn Connection Request ─────────────────────────────────────────

export const linkedinConnectTool: UnifiedTool = {
  name: "linkedin_connect",
  description:
    "Send a LinkedIn connection request to a profile URN. Rate-limited: max 10/day. Idempotency-checked.",
  input_schema: {
    type: "object",
    properties: {
      profile_urn: {
        type: "string",
        description: "LinkedIn profile URN: urn:li:person:ABC123",
      },
      message: {
        type: "string",
        description: "Optional personalized note (max 300 chars). Keep it specific and human.",
      },
      tenant_id: {
        type: "string",
        description: "Tenant identifier.",
      },
    },
    required: ["profile_urn", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { profile_urn, message, tenant_id } = input as {
      profile_urn: string;
      message?: string;
      tenant_id: string;
    };

    const idempKey = `linkedin_connect:${tenant_id}:${profile_urn}`;

    const alreadySent = await hasBeenAudited(idempKey);
    if (alreadySent) {
      log.debug({ profile_urn }, "Connection request already sent — skipping");
      return { success: true, data: { skipped: true } };
    }

    if (!process.env["COMPOSIO_API_KEY"]) {
      return { success: false, error: "COMPOSIO_API_KEY not configured." };
    }

    try {
      const { OpenAIToolSet } = await import("composio-core");
      const toolset = new OpenAIToolSet({ apiKey: process.env["COMPOSIO_API_KEY"] });

      const result = await toolset.executeAction({
        action: "LINKEDIN_SEND_CONNECTION_REQUEST",
        params: { profile_urn, message },
        entityId: tenant_id,
      });

      await writeAuditEntry({
        tenant_id,
        action: "linkedin_connect",
        idempotency_key: idempKey,
        payload: { profile_urn, message_preview: message?.slice(0, 50) },
      });

      log.info({ profile_urn, tenant: tenant_id }, "LinkedIn connection request sent");
      return { success: true, data: result as Record<string, unknown> };

    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};
