/**
 * FounderOS — Outbound Target List (Phase D)
 * ===========================================
 * A persistent, deduplicated list of companies the founder wants to prospect
 * this week. Stored as the `outbound_targets` key inside the per-tenant
 * `founder_context` JSONB blob (no new table — see PHASE-C decision 2).
 *
 * The founder adds targets as they encounter them over the week (`/target`),
 * then batch-scores the whole list on demand (`/outbound`) or after the Monday
 * scheduler nudge. Pure Postgres read/write — zero LLM cost.
 */

import { getFounderContext, upsertFounderContext } from "../db/queries.js";

/** founder_context key under which the target list lives. */
export const TARGETS_KEY = "outbound_targets";

/** Hard cap so the JSONB blob can never grow unbounded. */
export const MAX_TARGETS = 50;

/** Read the current outbound target list (empty array if unset). */
export async function getOutboundTargets(tenant: string): Promise<string[]> {
  const ctx = await getFounderContext(tenant);
  const raw = ctx[TARGETS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => String(c).trim()).filter(Boolean);
}

/**
 * Add one or more companies to the list, case-insensitively deduplicated.
 * Returns which were newly added and the resulting (capped) list.
 */
export async function addOutboundTargets(
  tenant: string,
  companies: string[],
): Promise<{ added: string[]; targets: string[] }> {
  const current = await getOutboundTargets(tenant);
  const seen = new Set(current.map((c) => c.toLowerCase()));
  const added: string[] = [];

  for (const raw of companies) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (current.length >= MAX_TARGETS) break;
    seen.add(key);
    current.push(name);
    added.push(name);
  }

  if (added.length > 0) {
    await upsertFounderContext(tenant, { [TARGETS_KEY]: current });
  }
  return { added, targets: current };
}

/** Remove one company (case-insensitive). Returns whether anything changed. */
export async function removeOutboundTarget(
  tenant: string,
  company: string,
): Promise<{ removed: boolean; targets: string[] }> {
  const current = await getOutboundTargets(tenant);
  const key = company.trim().toLowerCase();
  const next = current.filter((c) => c.toLowerCase() !== key);
  const removed = next.length < current.length;
  if (removed) {
    await upsertFounderContext(tenant, { [TARGETS_KEY]: next });
  }
  return { removed, targets: next };
}

/** Clear the entire target list. */
export async function clearOutboundTargets(tenant: string): Promise<void> {
  await upsertFounderContext(tenant, { [TARGETS_KEY]: [] });
}
