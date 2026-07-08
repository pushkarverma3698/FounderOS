/**
 * FounderOS — HITL Core (shared by every agent-tool module)
 * ==========================================================
 * The approval primitive used by all write/send tools. Splitting agent-tools.ts
 * by department keeps each file focused; this module holds what they all share.
 *
 * Approval contract (read by the Telegram gateway):
 *   interrupt({ kind: "approval", action, title, summary, preview, args })
 *   resume value: "approved" | "rejected"
 *
 * interrupt() RE-EXECUTION: when interrupt() fires the tool throws and the graph
 * pauses; on resume the tool re-runs from the top and interrupt() RETURNS the
 * resume value. Code BEFORE the gate runs twice — keep it pure. All real
 * side-effects (DB writes, sends) must happen AFTER the gate.
 *
 * DB row is written BEFORE interrupt() (rule #4) so a crash between write and
 * interrupt is recoverable. On re-execution we skip a second insert if pending.
 */

import { interrupt } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createHash } from "node:crypto";
import { TENANT } from "../core/config.js";
import { createInterrupt, getPendingInterrupt } from "../db/queries.js";

const HITL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic idempotency key so the same action never fires twice.
 *
 * Key = `{prefix}:{TENANT}:{sha1(parts)}` — tenant-scoped + content-addressed.
 * This key is intentionally TIME-INVARIANT, which makes it the correct, safe
 * default for HITL-RESUME idempotency: when interrupt() fires, the tool throws,
 * the founder approves minutes-or-hours later, and the tool re-runs from the top.
 * The key MUST be byte-identical across that gap so the post-approval `hasBeenAudited`
 * check skips the second execution. A time component here would change across an
 * approval that crosses midnight → the action re-executes → DOUBLE-SEND. So every
 * write/exec tool that gates behind interrupt() (shell, claude_code, github, mcp,
 * email, linkedin, gcal) uses THIS function — never the windowed variant below.
 */
export function idemKey(prefix: string, ...parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
  return `${prefix}:${TENANT}:${h}`;
}

/** Calendar granularity for a legitimately-repeatable action's time window. */
export type BucketGranularity = "day" | "week" | "month";

/**
 * UTC time-bucket label for the given instant. Pure (instant is injectable).
 *   day   → "2026-06-29"     (ISO date)
 *   week  → "2026-W26"       (ISO week — Thursday-anchored, matches ISO-8601)
 *   month → "2026-06"
 * UTC is used so the bucket boundary is deterministic regardless of server TZ
 * (a DST/locale shift must never silently move an action into a new window).
 */
export function timeBucket(granularity: BucketGranularity, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  if (granularity === "month") {
    return `${y}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  if (granularity === "day") {
    return `${y}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  }
  // ISO-8601 week number: the week with the year's first Thursday is week 1.
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // shift to the Thursday of this week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * Idempotency key for actions that are LEGITIMATELY repeatable on a schedule —
 * a weekly newsletter, a monthly report, a recurring reminder with identical
 * copy. Same content within the same window dedupes (no accidental double-fire
 * inside one period); the next window is a fresh, allowed action.
 *
 * ⚠️ NEVER use this for a tool that gates behind interrupt(): if the founder
 * approves across the window boundary the key changes and the action re-executes.
 * Resume-gated tools MUST use idemKey() (time-invariant). This variant is for
 * NON-interactive scheduled senders (workflows/scheduler) that fire-and-audit
 * without a human approval gap. See idemKey() doc for the resume-safety rationale.
 */
export function recurringIdemKey(
  prefix: string,
  granularity: BucketGranularity,
  ...parts: string[]
): string {
  return idemKey(prefix, ...parts, timeBucket(granularity));
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

function threadIdFrom(config: RunnableConfig | undefined): string | undefined {
  return config?.configurable?.["thread_id"] as string | undefined;
}

/**
 * HITL gate — writes hitl_approvals then wraps interrupt() with the approval protocol.
 * Returns null when approved (execution continues).
 * Returns a rejection string when rejected — callers must return it immediately.
 */
export async function hitlGate(
  payload: Omit<ApprovalRequest, "kind">,
  config?: RunnableConfig,
): Promise<string | null> {
  const threadId = threadIdFrom(config);
  if (threadId) {
    const existing = await getPendingInterrupt(threadId);
    if (!existing) {
      await createInterrupt({
        thread_id: threadId,
        tenant_id: TENANT,
        status: "pending",
        callback_data: JSON.stringify(payload),
        expires_at: new Date(Date.now() + HITL_TTL_MS),
      });
    }
  }

  const decision = interrupt({ kind: "approval", ...payload } satisfies ApprovalRequest) as string;
  return decision !== "approved" ? "❌ Rejected by founder." : null;
}
