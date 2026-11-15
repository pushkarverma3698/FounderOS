/**
 * FounderOS — Named Query Functions
 * ===================================
 * Type-safe, named query functions — no raw SQL scattered in agent files.
 * All queries go through Drizzle's query builder.
 *
 * Pattern: verbs + domain — createInterrupt, resolveInterrupt, logCost, checkIdempotency
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";

import {
  actionLog,
  hitlApprovals,
  aiCallCosts,
  doNotContact,
  type NewActionLog,
  type NewHitlApproval,
  type NewAiCallCost,
} from "./schema.js";

// ── HITL Approvals (hitl_approvals) ──────────────────────────────────────────

/** Write a HITL approval request BEFORE calling LangGraph interrupt(). */
export async function createInterrupt(
  data: Omit<NewHitlApproval, "interrupt_id" | "created_at">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(hitlApprovals)
    .values(data)
    .returning({ interrupt_id: hitlApprovals.interrupt_id });
  if (!row) throw new Error("createInterrupt: insert returned no rows");
  return row.interrupt_id;
}

/** Resolve an interrupt (approve or reject). Returns false if not found. */
export async function resolveInterrupt(
  interruptId: string,
  status: "approved" | "rejected" | "expired",
  opts: { rejection_reason?: string; edits?: string } = {},
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .update(hitlApprovals)
    .set({
      status,
      resolved_at: new Date(),
      rejection_reason: opts.rejection_reason ?? null,
      edits: opts.edits ?? null,
    })
    .where(
      and(
        eq(hitlApprovals.interrupt_id, interruptId),
        eq(hitlApprovals.status, "pending"),
      ),
    )
    .returning({ interrupt_id: hitlApprovals.interrupt_id });

  return result.length > 0;
}

/** Fetch pending interrupt for a thread (max 1 active at a time). */
export async function getPendingInterrupt(threadId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(hitlApprovals)
    .where(
      and(
        eq(hitlApprovals.thread_id, threadId),
        eq(hitlApprovals.status, "pending"),
      ),
    )
    .limit(1);
  return row ?? null;
}


// ── AI Call Costs (ai_call_costs) ─────────────────────────────────────────────

/** Record a single LLM call's token usage + cost. */
export async function logLlmCost(data: Omit<NewAiCallCost, "id" | "created_at">): Promise<void> {
  const db = getDb();
  await db.insert(aiCallCosts).values(data);
}

// ── Action Log (action_log) ───────────────────────────────────────────────────

/**
 * Idempotency check. Returns true if the action has already been performed.
 * Call BEFORE executing any external action.
 */
export async function hasBeenAudited(idempotencyKey: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: actionLog.id })
    .from(actionLog)
    .where(eq(actionLog.idempotency_key, idempotencyKey))
    .limit(1);
  return row !== undefined;
}


/**
 * Write an action log entry AFTER a successful external action.
 * Returns { written: true } on first write, { written: false } if the
 * idempotency key already existed (double-send guard silently won the race).
 * Callers MUST check written === false and log a warning — a false return
 * means the caller's hasBeenAudited() check was beaten by a concurrent
 * request and the external action may have fired twice.
 */
export async function writeAuditEntry(
  data: Omit<NewActionLog, "id" | "created_at">,
): Promise<{ written: boolean }> {
  const db = getDb();
  const rows = await db
    .insert(actionLog)
    .values(data)
    .onConflictDoNothing()
    .returning({ id: actionLog.id });
  return { written: rows.length > 0 };
}

// ── Outbound Leads (outbound_leads) ──────────────────────────────────────────
// ── Do Not Contact (do_not_contact) ──────────────────────────────────────────

/**
 * Check if an email or its domain is on the do-not-contact list.
 * Checks both exact match and domain-prefix match (e.g. "@acme.com").
 */
export async function isSuppressed(tenantId: string, email: string): Promise<boolean> {
  if (!email.includes("@")) {
    // Malformed email — log and treat as not suppressed to avoid blocking valid sends
    const { childLogger } = await import("../infra/logger.js");
    childLogger({ module: "queries" }).warn({ email }, "isSuppressed: malformed email (no @) — treating as not suppressed");
    return false;
  }
  const domain = "@" + email.split("@")[1];
  const db = getDb();
  const [row] = await db
    .select({ id: doNotContact.id })
    .from(doNotContact)
    .where(
      and(
        eq(doNotContact.tenant_id, tenantId),
        sql`${doNotContact.email_or_domain} IN (${email}, ${domain})`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

// ── Agent Results (agent_results) — Self-Improvement ─────────────────────────
// ── Turn latency percentiles (agent_results.latency_ms) ──────────────────────
//
// The invariant this section holds is the one from src/infra/rag-optimization-sweep.ts:
// **a metric computed over almost nothing and a metric computed over everything must
// never look the same from outside.** A P95 over 3 of 400 rows is not the system's P95,
// so coverage travels with the numbers and "no measured rows" is a distinct return
// branch, not a percentile of zero.

/** Median. Named because tests assert against the constant, not the literal. */
export const LATENCY_P50 = 0.5;
/** Tail latency — the number an SLO is written against. */
export const LATENCY_P95 = 0.95;
/** Worst-case tail — catches the slow path a P95 hides. */
export const LATENCY_P99 = 0.99;

/** The raw aggregate row. `unknown` because pg returns int8/numeric as strings. */
export interface TurnLatencyAggregateRow {
  readonly total_rows: unknown;
  readonly measured_rows: unknown;
  readonly p50_ms: unknown;
  readonly p95_ms: unknown;
  readonly p99_ms: unknown;
}

interface TurnLatencyPercentiles {
  /** Every agent_results row in the window, measured or not. */
  readonly totalRows: number;
  /** Rows with a non-NULL latency_ms — the only rows the percentiles are computed over. */
  readonly measuredRows: number;
  /** Rows excluded because latency_ms was NULL. */
  readonly excludedRows: number;
  /** measuredRows / totalRows, 0–100, one decimal. */
  readonly coveragePercent: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  /** Full sentence with the real numbers — safe to print to the founder verbatim. */
  readonly summary: string;
}

/**
 * Either real percentiles, or the reason there are none. Encoding the empty case in
 * the return type is what stops a caller rendering "P95: 0ms" for a window that
 * measured nothing.
 */
type TurnLatencyResult =
  | { readonly ok: true; readonly percentiles: TurnLatencyPercentiles }
  | { readonly ok: false; readonly reason: string };

/** Parse a pg aggregate cell to a finite number, or `null`. Never returns NaN. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * PURE: turn one aggregate row into a result. No I/O, no clock — unit-testable
 * against an object literal, which is why the SQL and the interpretation are split.
 */
export function summarizeTurnLatency(
  row: TurnLatencyAggregateRow | undefined,
  days: number,
): TurnLatencyResult {
  const window = `the last ${days} day${days === 1 ? "" : "s"}`;
  if (!row) return { ok: false, reason: `No aggregate row returned for ${window}.` };

  const totalRows = finiteOrNull(row.total_rows);
  const measuredRows = finiteOrNull(row.measured_rows);
  if (totalRows === null || measuredRows === null) {
    return { ok: false, reason: `Row counts for ${window} were unreadable, so no latency can be reported.` };
  }
  if (totalRows === 0) {
    return { ok: false, reason: `No turns were recorded at all in ${window}, so there is no latency to measure.` };
  }
  if (measuredRows === 0) {
    return {
      ok: false,
      reason: `${totalRows} turns were recorded in ${window} but none carries a latency_ms value, so no percentile can be computed.`,
    };
  }

  const p50Ms = finiteOrNull(row.p50_ms);
  const p95Ms = finiteOrNull(row.p95_ms);
  const p99Ms = finiteOrNull(row.p99_ms);
  if (p50Ms === null || p95Ms === null || p99Ms === null) {
    return {
      ok: false,
      reason: `${measuredRows} measured turns in ${window} produced a non-numeric percentile, so the result is not trustworthy.`,
    };
  }

  const excludedRows = totalRows - measuredRows;
  const coveragePercent = Math.round((measuredRows / totalRows) * 1000) / 10;
  const summary =
    `Turn latency over ${window}: P50 ${Math.round(p50Ms)}ms · P95 ${Math.round(p95Ms)}ms · P99 ${Math.round(p99Ms)}ms, ` +
    `computed over ${measuredRows} of ${totalRows} recorded turns (${coveragePercent}% coverage; ` +
    `${excludedRows} excluded for having no latency_ms).`;

  return { ok: true, percentiles: { totalRows, measuredRows, excludedRows, coveragePercent, p50Ms, p95Ms, p99Ms, summary } };
}

// ── Dept Signals (dept_signals) — Cross-Department ───────────────────────────
// ── Founder Context (founder_context) ─────────────────────────────────────────



// ── Conversations (conversations) ─────────────────────────────────────────────
// ── Episodic Memory (episodic_memory) ─────────────────────────────────────────
// ── Daily Outbound Quota (action_log) ─────────────────────────────────────────
// ── scheduled_posts (server-side social scheduling) ──────────────────────────
// ── scheduled_tasks (founder-scheduled future kernel turns) ───────────────────
// ── reminders (founder-facing pure ping — zero-LLM) ───────────────────────────
// ── failure_lessons (Hermes learning seam — kernel LessonStore backing) ───────
// ── Saved workflows (saved_workflows) ─────────────────────────────────────────
// ── evolution_runs / evolution_findings (self-audit memory) ───────────────────
// See src/db/schema.ts for the status machine and src/evolution/persist-findings.ts
// for the orchestration these functions back.
// ── Activity Summary (action_log) ─────────────────────────────────────────────
// ── Last Episodic Event (episodic_memory) ─────────────────────────────────────
// ── Missions (MISO mission control) ───────────────────────────────────────────

