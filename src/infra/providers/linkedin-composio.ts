/**
 * FounderOS — LinkedIn via Composio (legacy fallback)
 * =====================================================
 * Kept behind LINKEDIN_BACKEND=composio for rollback.
 */

import { childLogger } from "../logger.js";
import {
  executeComposioAction,
  getComposioApiKey,
  getLinkedInConnectionId,
  getLinkedInUserId,
  getLinkedInAuthorUrn,
} from "../composio.js";
import type { ToolResult } from "../../tools/index.js";
import type { LinkedInPostInput } from "./types.js";

const log = childLogger({ module: "provider:composio-linkedin" });

export function composioLinkedInConfigured(): boolean {
  return !!getComposioApiKey();
}

export async function composioLinkedInPost(input: LinkedInPostInput): Promise<ToolResult> {
  if (!composioLinkedInConfigured()) {
    return {
      success: false,
      error: "COMPOSIO_API_KEY not configured. Set LINKEDIN_BACKEND=direct or add COMPOSIO_API_KEY.",
    };
  }

  try {
    const composioArgs: Record<string, unknown> = {
      author: input.author_urn || getLinkedInAuthorUrn(),
      commentary: input.text,
      visibility: input.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
      ...(input.image_url ? { images: [{ url: input.image_url }] } : {}),
      ...(input.schedule_time ? { scheduled_publish_time: input.schedule_time } : {}),
    };

    const result = await executeComposioAction(
      "LINKEDIN_CREATE_LINKED_IN_POST",
      composioArgs,
      getLinkedInConnectionId(),
      getLinkedInUserId(),
    );

    const data = result["data"] as Record<string, unknown> | undefined;
    const postId = (data?.["x_restli_id"] ??
      data?.["id"] ??
      data?.["post_id"] ??
      result["id"]) as string | undefined;

    if (!postId) {
      const msg = (data?.["message"] ?? "LinkedIn post failed — no post id returned") as string;
      const scheduleHint = input.schedule_time
        ? " Scheduling may not be supported via this Composio connection."
        : "";
      log.error({ err: msg }, "Composio LinkedIn soft failure");
      return { success: false, error: `${msg}${scheduleHint}` };
    }

    const postUrl = `https://www.linkedin.com/feed/update/${postId}`;
    log.info({ post_id: postId, backend: "composio" }, "LinkedIn post published");
    return { success: true, data: { post_id: postId, post_url: postUrl } };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message }, "Composio LinkedIn post failed");
    return { success: false, error: message };
  }
}

export async function composioLinkedInAnalytics(postId: string): Promise<ToolResult> {
  if (!composioLinkedInConfigured()) {
    return { success: false, error: "COMPOSIO_API_KEY not configured." };
  }

  try {
    const result = await executeComposioAction(
      "LINKEDIN_GET_POST_ANALYTICS",
      { post_id: postId },
      getLinkedInConnectionId(),
      getLinkedInUserId(),
    );
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

export async function composioLinkedInConnect(
  profileUrn: string,
  message: string | undefined,
): Promise<ToolResult> {
  if (!composioLinkedInConfigured()) {
    return { success: false, error: "COMPOSIO_API_KEY not configured." };
  }

  try {
    const result = await executeComposioAction(
      "LINKEDIN_SEND_CONNECTION_REQUEST",
      { profile_urn: profileUrn, message },
      getLinkedInConnectionId(),
      getLinkedInUserId(),
    );
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
