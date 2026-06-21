/**
 * FounderOS — LinkedIn Tool
 * =========================
 * Posting + analytics via provider backend (direct API default).
 * Connection requests remain Composio-only and are policy-blocked on direct.
 *
 * See ADR-009 (ban risk) and ADR-029 (direct integrations).
 */

import { childLogger } from "../infra/logger.js";
import { writeAuditEntry, hasBeenAudited } from "../db/queries.js";
import {
  providerLinkedInAnalytics,
  providerLinkedInConnect,
  providerLinkedInPost,
} from "../infra/providers/index.js";
import { getLinkedInBackend } from "../infra/provider-config.js";
import { getLinkedInAccount } from "../infra/account-registry.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:linkedin" });

export interface LinkedInPostInput {
  text: string;
  image_url?: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
  schedule_time?: string;
}

export interface LinkedInAnalyticsResult {
  impressions: number;
  reactions: number;
  comments: number;
  shares: number;
  click_rate?: number;
}

export const linkedinPostTool: UnifiedTool = {
  name: "linkedin_post",
  description:
    "Publish a LinkedIn text post. Idempotency-checked — same content will not be posted twice in the same day.",
  input_schema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The post body. 80–300 words, mobile-first formatting.",
      },
      image_url: { type: "string", description: "Optional public image URL to attach." },
      visibility: {
        type: "string",
        enum: ["PUBLIC", "CONNECTIONS"],
        description: "Post visibility. Default: PUBLIC.",
      },
      idempotency_key: {
        type: "string",
        description: "Unique key for idempotency (e.g. 'linkedin_post:turicks:build_log:2024-W03')",
      },
      tenant_id: { type: "string", description: "Tenant identifier (e.g. 'turicks')." },
      schedule_time: {
        type: "string",
        description: "Optional ISO 8601 datetime to schedule the post. Direct API: not yet supported.",
      },
    },
    required: ["text", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const {
      text,
      image_url,
      visibility = "PUBLIC",
      idempotency_key,
      tenant_id,
      schedule_time,
      account_key,
      department,
    } = input as {
      text: string;
      image_url?: string;
      visibility?: "PUBLIC" | "CONNECTIONS";
      idempotency_key: string;
      tenant_id: string;
      schedule_time?: string;
      account_key?: string;
      department?: string;
    };

    const alreadyPosted = await hasBeenAudited(idempotency_key);
    if (alreadyPosted) {
      log.info({ idempotency_key }, "LinkedIn post already sent — skipping");
      return { success: true, data: { skipped: true, reason: "idempotency_key already used" } };
    }

    const { credentials, ctx } = await getLinkedInAccount({
      platform: "linkedin",
      account_key,
      department,
    });
    const authorUrn = credentials.author_urn;
    if (!authorUrn && getLinkedInBackend() === "direct") {
      return {
        success: false,
        error: `LinkedIn author URN not configured for account '${ctx.account_key}'. See ACCOUNT-REGISTRY-RUNBOOK.md.`,
      };
    }

    const result = await providerLinkedInPost({
      text,
      author_urn: authorUrn ?? "",
      image_url,
      visibility: visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
      schedule_time,
      account_key: ctx.account_key,
      department,
    });

    if (!result.success) {
      return result;
    }

    const data = result.data as Record<string, unknown> | undefined;
    const postId = data?.["post_id"] as string | undefined;
    if (!postId) {
      return { success: false, error: "LinkedIn post failed — provider returned no post id" };
    }

    const audit = await writeAuditEntry({
      tenant_id,
      action: "linkedin_post",
      idempotency_key,
      payload: {
        post_id: postId,
        text: text.slice(0, 100),
        visibility,
        backend: getLinkedInBackend(),
        account_key: ctx.account_key,
      },
    });
    if (!audit.written) {
      log.warn({ idempotency_key }, "writeAuditEntry: conflict — idempotency key already existed; LinkedIn post may have been published twice");
    }

    log.info({ post_id: postId, tenant: tenant_id }, "LinkedIn post published");
    return { success: true, data: { post_id: postId, post_url: data?.["post_url"] } };
  },
};

export const linkedinAnalyticsTool: UnifiedTool = {
  name: "linkedin_analytics",
  description: "Fetch engagement analytics for a LinkedIn post (impressions, reactions, comments).",
  input_schema: {
    type: "object",
    properties: {
      post_id: { type: "string", description: "LinkedIn post URN or ID." },
      tenant_id: { type: "string", description: "Tenant identifier." },
    },
    required: ["post_id", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { post_id } = input as { post_id: string; tenant_id: string };
    return providerLinkedInAnalytics(post_id);
  },
};

export const linkedinConnectTool: UnifiedTool = {
  name: "linkedin_connect",
  description:
    "Send a LinkedIn connection request to a profile URN. Rate-limited: max 10/day. Idempotency-checked.",
  input_schema: {
    type: "object",
    properties: {
      profile_urn: { type: "string", description: "LinkedIn profile URN: urn:li:person:ABC123" },
      message: {
        type: "string",
        description: "Optional personalized note (max 300 chars). Keep it specific and human.",
      },
      tenant_id: { type: "string", description: "Tenant identifier." },
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

    if (await hasBeenAudited(idempKey)) {
      log.debug({ profile_urn }, "Connection request already sent — skipping");
      return { success: true, data: { skipped: true } };
    }

    const result = await providerLinkedInConnect(profile_urn, message);
    if (!result.success) {
      return result;
    }

    await writeAuditEntry({
      tenant_id,
      action: "linkedin_connect",
      idempotency_key: idempKey,
      payload: { profile_urn, message_preview: message?.slice(0, 50) },
    });

    log.info({ profile_urn, tenant: tenant_id }, "LinkedIn connection request sent");
    return result;
  },
};
