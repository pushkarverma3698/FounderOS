/**
 * FounderOS — Scheduled Social Post Tool
 * =======================================
 * Persists an already-approved post into the scheduled_posts queue. A zero-LLM
 * cron sweep (src/infra/scheduler.ts) publishes it when its time arrives —
 * LinkedIn's Posts API has no native scheduling, so we schedule server-side.
 *
 * This tool ONLY validates + persists. Brand/judge gating and the HITL approval
 * card live in the agent-tool wrapper (agent-tools/comms.ts), matching the
 * linkedin.ts ↔ comms.ts split. Approval happens once, at schedule time.
 */

import { childLogger } from "../infra/logger.js";
import { insertScheduledPost } from "../db/queries.js";
import { resolveAccountKey, isPlatform, type Platform } from "../core/accounts.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:scheduled-post" });

export const scheduleSocialPostTool: UnifiedTool = {
  name: "schedule_social_post",
  description:
    "Queue an approved social post to publish at a future time (server-side scheduling). " +
    "Idempotency-checked. Currently wired for LinkedIn.",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Final, approved post body." },
      scheduled_at: { type: "string", description: "ISO 8601 datetime to publish at (must be future)." },
      platform: { type: "string", enum: ["linkedin"], description: "Target platform. Default: linkedin." },
      visibility: { type: "string", enum: ["PUBLIC", "CONNECTIONS"], description: "Default: PUBLIC." },
      mention_urn: { type: "string", description: "Optional org URN to @tag: urn:li:organization:123." },
      mention_name: { type: "string", description: "Exact Company Page name for the mention link." },
      idempotency_key: { type: "string", description: "Time-invariant dedup key." },
      tenant_id: { type: "string", description: "Tenant identifier." },
    },
    required: ["text", "scheduled_at", "idempotency_key", "tenant_id"],
  },

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const {
      text,
      scheduled_at,
      platform = "linkedin",
      visibility = "PUBLIC",
      mention_urn,
      mention_name,
      idempotency_key,
      tenant_id,
      account_key,
      department,
    } = input as {
      text: string;
      scheduled_at: string;
      platform?: string;
      visibility?: "PUBLIC" | "CONNECTIONS";
      mention_urn?: string;
      mention_name?: string;
      idempotency_key: string;
      tenant_id: string;
      account_key?: string;
      department?: string;
    };

    if (!isPlatform(platform)) {
      return { success: false, error: `Unknown platform '${platform}'.` };
    }

    const when = new Date(scheduled_at);
    if (Number.isNaN(when.getTime())) {
      return { success: false, error: `scheduled_at '${scheduled_at}' is not a valid ISO datetime.` };
    }
    if (when.getTime() <= Date.now()) {
      return { success: false, error: "scheduled_at must be in the future." };
    }

    const resolvedAccount = resolveAccountKey(platform as Platform, { department, account_key });

    const row = await insertScheduledPost({
      tenant_id,
      platform,
      account_key: resolvedAccount,
      text,
      mention_urn: mention_urn ?? null,
      mention_name: mention_name ?? null,
      visibility: visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
      scheduled_at: when,
      idempotency_key,
    });

    log.info(
      { id: row.id, platform, scheduled_at: when.toISOString(), tagged: !!mention_urn },
      "Social post scheduled",
    );
    return {
      success: true,
      data: {
        scheduled_post_id: row.id,
        scheduled_at: when.toISOString(),
        status: row.status,
        tagged: !!mention_urn,
      },
    };
  },
};
