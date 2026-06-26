/**
 * LinkedIn engagement assist tools — safe-assist per ADR-009 Option D.
 * Read-only: read_comments on your own posts.
 * No auto-send — HITL wrappers in agent-tools/comms.ts surface copy-paste drafts.
 */

import { childLogger } from "../infra/logger.js";
import { providerLinkedInReadComments } from "../infra/providers/index.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:linkedin-engagement" });

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
