/**
 * Auto-send ledger: attempts and results in agents.action_log, plus the history the limits read (ADR-018 amendment 2026-11-15).
 *
 * An attempt row is written BEFORE the click, under the unique key `auto-send-attempt:<rowId>`. That one row
 * is the cap counter, the cooldown record and the guarantee that a row is never auto-sent twice, also across a
 * restart: if the key exists, nothing is sent. An unconfirmed click leaves its attempt row, so it still counts.
 */

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { TENANT } from "../core/config.js";
import type { AutoSendHistory } from "../tools/jobhunt/auto-send-rules.js";
import { getDb } from "./client.js";
import { writeAuditEntry } from "./queries.js";
import { actionLog, jobApplications } from "./schema.js";

export const ATTEMPT_ACTION = "job_auto_send_attempt";
export const RESULT_ACTION = "job_auto_send_result";
const DAY_MS = 24 * 60 * 60 * 1000;
const COOLDOWN_DAYS = 30;

export const attemptKey = (rowId: string): string => `auto-send-attempt:${rowId}`;
const profileIs = (profileId: string) => sql`${actionLog.payload}->>'profileId' = ${profileId}`;

export const utcDayStart = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Claim the right to send this row. False when an attempt row already exists (never send twice). */
export async function reserveAutoSend(row: { id: string; company: string; title: string }, profileId: string): Promise<boolean> {
  const { written } = await writeAuditEntry({
    action: ATTEMPT_ACTION,
    idempotency_key: attemptKey(row.id),
    payload: { rowId: row.id, profileId, company: row.company, title: row.title },
    tenant_id: TENANT,
  });
  return written;
}

export async function recordAutoSendResult(rowId: string, profileId: string, result: string, detail: string): Promise<void> {
  await writeAuditEntry({
    action: RESULT_ACTION,
    idempotency_key: `auto-send-result:${rowId}`,
    payload: { rowId, profileId, result, detail: detail.slice(0, 300) },
    tenant_id: TENANT,
  });
}

/** What the daily cap and the 30-day company check read: manual and automatic applications alike. */
export async function loadAutoSendHistory(profileId: string, now: Date): Promise<AutoSendHistory> {
  const db = getDb();
  const since = new Date(now.getTime() - COOLDOWN_DAYS * DAY_MS);
  const applied = await db
    .select({ company: jobApplications.company, at: jobApplications.applied_at })
    .from(jobApplications)
    .where(and(eq(jobApplications.profile_id, profileId), gte(jobApplications.applied_at, since)));
  const attempts = await db
    .select({ payload: actionLog.payload, at: actionLog.created_at })
    .from(actionLog)
    .where(and(eq(actionLog.action, ATTEMPT_ACTION), profileIs(profileId), gte(actionLog.created_at, since)));
  const dayStart = utcDayStart(now).getTime();
  const recent: { company: string; at: Date }[] = [];
  for (const r of applied) if (r.at) recent.push({ company: r.company, at: r.at });
  let sentToday = 0;
  for (const a of attempts) {
    const company = (a.payload as { company?: unknown } | null)?.company;
    if (!a.at) continue;
    if (typeof company === "string") recent.push({ company, at: a.at });
    if (a.at.getTime() >= dayStart) sentToday += 1;
  }
  return { sentToday, recent };
}

export interface AutoSendLogEntry {
  readonly company: string;
  readonly title: string;
  readonly at: Date;
  readonly result: string;
}

/** The newest `limit` attempts for the profile with their recorded result ("pending" when none yet). */
export async function recentAutoSends(profileId: string, limit: number): Promise<AutoSendLogEntry[]> {
  const db = getDb();
  const attempts = await db
    .select({ payload: actionLog.payload, at: actionLog.created_at })
    .from(actionLog)
    .where(and(eq(actionLog.action, ATTEMPT_ACTION), profileIs(profileId)))
    .orderBy(desc(actionLog.created_at))
    .limit(limit);
  const ids = attempts.map((a) => (a.payload as { rowId?: string } | null)?.rowId).filter((v): v is string => typeof v === "string");
  const results = ids.length === 0 ? [] : await db
    .select({ payload: actionLog.payload })
    .from(actionLog)
    .where(and(eq(actionLog.action, RESULT_ACTION), inArray(actionLog.idempotency_key, ids.map((id) => `auto-send-result:${id}`))));
  const resultOf = new Map(results.map((r) => [(r.payload as { rowId?: string }).rowId, (r.payload as { result?: string }).result]));
  return attempts.map((a) => {
    const p = (a.payload ?? {}) as { rowId?: string; company?: string; title?: string };
    return { company: p.company ?? "?", title: p.title ?? "?", at: a.at ?? new Date(0), result: resultOf.get(p.rowId) ?? "pending" };
  });
}
