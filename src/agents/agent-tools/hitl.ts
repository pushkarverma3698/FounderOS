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
import { TENANT } from "../../core/config.js";
import { createInterrupt, getPendingInterrupt } from "../../db/queries.js";

const HITL_TTL_MS = 24 * 60 * 60 * 1000;

/** Deterministic idempotency key so the same action never fires twice. */
export function idemKey(prefix: string, ...parts: string[]): string {
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
