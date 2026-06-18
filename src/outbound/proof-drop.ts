/**
 * FounderOS — Proof Drop Pipeline (Phase D-Bis)
 * ===============================================
 * Turns a target AI/dev-tool startup into a high-craft outbound motion:
 *   research → artifact concept → personalized outreach (HITL-gated)
 *
 * Proof Drops are Turicks' Phase D-Bis GTM wedge: 2–3 custom launch artifacts
 * per week to the 30-account target list (see docs/strategy/03-GTM-ACQUISITION-ENGINE.md).
 *
 * Pure functions here are unit-tested without LLM/DB. Tracking uses founder_context
 * JSONB (same pattern as outbound_targets — no new table).
 */

import { getFounderContext, upsertFounderContext } from "../db/queries.js";

/** founder_context key for completed proof-drop attempts this week. */
export const PROOF_DROP_LOG_KEY = "proof_drop_log";

/** Phase D-Bis cadence target — high craft, low volume. */
export const WEEKLY_PROOF_DROP_TARGET = 2;

/** ICP gate — below this score the workflow should stop early. */
export const PROOF_DROP_MIN_ICP = 6;

/** Artifact types the marketing step may propose (creative brief, not a build). */
export const PROOF_DROP_ARTIFACT_TYPES = [
  "hero_redesign",
  "launch_teaser",
  "brand_motion",
] as const;

export type ProofDropArtifactType = (typeof PROOF_DROP_ARTIFACT_TYPES)[number];

export interface ProofDropLogEntry {
  company: string;
  at: string;
}

export interface ProofDropStats {
  countThisWeek: number;
  target: number;
  remaining: number;
  recent: ProofDropLogEntry[];
}

/** Monday 00:00 local time for the given date. */
export function getWeekStart(d = new Date()): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay();
  const diff = day === 0 ? 6 : day - 1;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

/** Count proof drops logged since the start of the current ISO week. */
export function countProofDropsThisWeek(
  entries: ProofDropLogEntry[],
  now = new Date(),
): number {
  const weekStart = getWeekStart(now).getTime();
  return entries.filter((e) => {
    const t = Date.parse(e.at);
    return Number.isFinite(t) && t >= weekStart;
  }).length;
}

/** Parse stored log entries from founder_context. */
export function parseProofDropLog(raw: unknown): ProofDropLogEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const company = String((row as { company?: unknown }).company ?? "").trim();
      const at = String((row as { at?: unknown }).at ?? "").trim();
      if (!company || !at) return null;
      return { company, at };
    })
    .filter((e): e is ProofDropLogEntry => e !== null);
}

/** Build stats from a raw log array. */
export function buildProofDropStats(
  entries: ProofDropLogEntry[],
  now = new Date(),
): ProofDropStats {
  const weekStart = getWeekStart(now).getTime();
  const thisWeek = entries.filter((e) => Date.parse(e.at) >= weekStart);
  const countThisWeek = thisWeek.length;
  return {
    countThisWeek,
    target: WEEKLY_PROOF_DROP_TARGET,
    remaining: Math.max(0, WEEKLY_PROOF_DROP_TARGET - countThisWeek),
    recent: entries.slice(-5).reverse(),
  };
}

/** Read proof-drop stats for a tenant. */
export async function getProofDropStats(tenant: string): Promise<ProofDropStats> {
  const ctx = await getFounderContext(tenant);
  const entries = parseProofDropLog(ctx[PROOF_DROP_LOG_KEY]);
  return buildProofDropStats(entries);
}

/**
 * Append a proof-drop attempt after a workflow completes.
 * Returns updated weekly stats.
 */
export async function recordProofDrop(
  tenant: string,
  company: string,
  at = new Date(),
): Promise<ProofDropStats> {
  const ctx = await getFounderContext(tenant);
  const entries = parseProofDropLog(ctx[PROOF_DROP_LOG_KEY]);
  entries.push({ company: company.trim(), at: at.toISOString() });
  const capped = entries.slice(-100);
  await upsertFounderContext(tenant, { [PROOF_DROP_LOG_KEY]: capped });
  return buildProofDropStats(capped, at);
}

/**
 * Format weekly cadence for Telegram (HTML).
 */
export function formatProofDropStats(stats: ProofDropStats): string {
  const bar =
    stats.countThisWeek >= stats.target
      ? "✅ On track"
      : `📌 ${stats.remaining} more this week`;
  const recent =
    stats.recent.length > 0
      ? stats.recent.map((e) => `• ${e.company}`).join("\n")
      : "• none yet";
  return (
    `<b>Proof Drops this week:</b> ${stats.countThisWeek}/${stats.target} — ${bar}\n` +
    `<b>Recent:</b>\n${recent}`
  );
}

/**
 * Build the mid-week cadence nudge when below target (pure — no I/O).
 */
export function buildProofDropCadenceNudge(stats: ProofDropStats): string | null {
  if (stats.countThisWeek >= stats.target) return null;
  return (
    `🎁 <b>Proof Drop cadence</b>\n\n` +
    `You're at <b>${stats.countThisWeek}/${stats.target}</b> this week (Phase D-Bis target: 2–3 high-craft artifacts).\n\n` +
    `Pick a target from <code>/targets</code> and run:\n` +
    `<code>/proofdrop CompanyName</code>\n\n` +
    `Research → artifact concept → outreach draft — you approve before anything sends.`
  );
}

/**
 * Validate a company name for proof-drop commands.
 */
export function normalizeProofDropCompany(raw: string): string | null {
  const name = raw.trim();
  if (!name || name.length > 120) return null;
  return name;
}
