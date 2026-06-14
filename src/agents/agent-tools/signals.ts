/**
 * FounderOS — Cross-department signals (Phase 4)
 * ==============================================
 * Durable, async coordination between departments over Postgres (`dept_signals`),
 * typed by the ADR-022 contracts. A department emits a signal mid-task
 * (`publish_signal`); a scheduler sweep later consumes it and surfaces it to the
 * founder (see `sweepDeptSignals` in scheduler.ts). This decouples *discovery*
 * (now, in one department's run) from *action* (later, founder-gated) without
 * BullMQ/Redis — the codebase's own deferral note (rule #15: Postgres for durable).
 *
 * The exemplar flow: research ICP-scores a prospect → publish_signal(lead_discovered)
 * → durable row → scheduler revenue sweep → proactive Telegram nudge → the founder
 * runs the (HITL-gated) outreach. The outbound send is NEVER auto-fired from cron;
 * the signal only surfaces work, it doesn't perform it.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { RunnableConfig } from "@langchain/core/runnables";
import { TENANT } from "../../core/config.js";
import { publishDeptEvent } from "../../db/queries.js";
import { validateSignalPayload, SIGNAL_EVENT_TYPES } from "../contracts.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:signals" });

/** Which department consumes each event by default (overridable per call). */
export const DEFAULT_TARGET_DEPT: Record<string, string> = {
  lead_discovered: "sales",
  proposal_approved: "engineering",
  demo_ready: "sales",
};

/** The department that owns the publish_signal tool today (the discoverer). */
const PUBLISHER_DEPT = "research";

export type PreparedSignal =
  | {
      ok: true;
      signal: {
        from_dept: string;
        to_dept: string;
        event_type: string;
        payload: unknown;
        thread_id?: string;
      };
    }
  | { ok: false; error: string };

/**
 * Pure boundary: validate the payload against its typed contract and resolve the
 * target department BEFORE any DB write. Returns the row to insert or an error.
 */
export function prepareSignal(
  eventType: string,
  payload: unknown,
  opts: { toDept?: string; threadId?: string; fromDept?: string } = {},
): PreparedSignal {
  const validation = validateSignalPayload(eventType, payload);
  if (!validation.ok) return { ok: false, error: validation.error };

  const toDept = opts.toDept ?? DEFAULT_TARGET_DEPT[eventType] ?? "sales";
  return {
    ok: true,
    signal: {
      from_dept: opts.fromDept ?? PUBLISHER_DEPT,
      to_dept: toDept,
      event_type: validation.eventType,
      payload: validation.payload,
      ...(opts.threadId ? { thread_id: opts.threadId } : {}),
    },
  };
}

// ── Tool ─────────────────────────────────────────────────────────────────────

export const publishSignal = tool(
  async ({ event_type, payload, to_dept }, config: RunnableConfig | undefined) => {
    const threadId = config?.configurable?.["thread_id"] as string | undefined;
    const prepared = prepareSignal(event_type, payload, {
      ...(to_dept ? { toDept: to_dept } : {}),
      ...(threadId ? { threadId } : {}),
    });
    if (!prepared.ok) return `Signal rejected (typed contract): ${prepared.error}`;

    const id = await publishDeptEvent({ tenant_id: TENANT, ...prepared.signal });
    log.info({ id, event_type, to_dept: prepared.signal.to_dept }, "Dept signal published");
    return `📡 Signal recorded (${event_type} → ${prepared.signal.to_dept}). It will surface to the founder on the next revenue sweep — no message sent yet.`;
  },
  {
    name: "publish_signal",
    description:
      "Record a durable cross-department signal (e.g. a qualified lead) for later async follow-up. Use when you discover something a DIFFERENT department should act on later — NOT for sending anything now. The signal surfaces to the founder as a proactive nudge; it never sends an email or posts on its own.",
    schema: z.object({
      event_type: z
        .enum(SIGNAL_EVENT_TYPES)
        .describe(`The signal type. One of: ${SIGNAL_EVENT_TYPES.join(", ")}.`),
      payload: z
        .record(z.unknown())
        .describe(
          "Structured details for the event. lead_discovered requires {company, icpScore (0-100), source}; optional contactName, contactEmail, notes.",
        ),
      to_dept: z
        .string()
        .optional()
        .nullable()
        .describe("Target department (optional — sensible default per event type)."),
    }),
  },
);
