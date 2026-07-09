/**
 * LinkedIn engagement assist tools — safe-assist per ADR-009 Option D.
 * Read-only: read_comments on your own posts.
 * No auto-send — HITL wrappers in agent-tools/comms.ts surface copy-paste drafts.
 */

import { childLogger } from "../infra/logger.js";
import { providerLinkedInReadComments, providerLinkedInGetMyPosts } from "../infra/providers/index.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:linkedin-engagement" });

export const linkedinGetMyPostsTool: UnifiedTool = {
  name: "linkedin_get_my_posts",
  description:
    "Fetch your own recent LinkedIn post IDs. Use this when the founder says 'my latest post' or 'my posts' " +
    "without specifying a post URN. Returns post IDs for use with linkedin_read_comments. " +
    "Falls back to FounderOS audit log if r_member_social scope is absent.",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max posts to return (default 5)" },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const { limit } = args as { limit?: number };
    log.info({ limit }, "Fetching own LinkedIn posts");
    return providerLinkedInGetMyPosts({ limit });
  },
};

export const linkedinReadCommentsTool: UnifiedTool = {
  name: "linkedin_read_comments",
  description:
    "Read comments on a LinkedIn post (your own posts only). Returns author URN + comment text. " +
    "Requires r_member_social OAuth scope — returns a clear error if the scope is absent.",
  input_schema: {
    type: "object",
    properties: {
      post_id: {
        type: "string",
        description: "LinkedIn post URN or ID (e.g. urn:li:share:123456789)",
      },
      limit: {
        type: "string",
        description: "Max comments to return (default 20)",
      },
    },
    required: ["post_id"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const { post_id, limit } = args as { post_id: string; limit?: number };
    log.info({ post_id }, "Reading LinkedIn comments");
    return providerLinkedInReadComments(post_id, { limit });
  },
};
