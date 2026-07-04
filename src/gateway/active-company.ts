/**
 * FounderOS — Per-thread active company
 * ======================================
 * Tracks which business a chat thread is currently operating as. Set via the
 * /company command; defaults to the boot tenant. In-memory by design — bounded
 * scope (durable per-thread company persistence is Phase-E SaaS work, deferred).
 *
 * Pure map accessors — unit-tested, no I/O (rule #16).
 */

import { DEFAULT_COMPANY_KEY, isCompanyKey } from "../core/companies.js";

/** chatId → active company key. Absent = default boot tenant. */
const active = new Map<string | number, string>();

/** The company key currently active for a chat (defaults to the boot tenant). */
export function getActiveCompany(chatId: string | number): string {
  return active.get(chatId) ?? DEFAULT_COMPANY_KEY;
}

/** Set the active company for a chat. Returns false for an unknown key (no-op). */
export function setActiveCompany(chatId: string | number, key: string): boolean {
  const k = key.trim().toLowerCase();
  if (!isCompanyKey(k)) return false;
  active.set(chatId, k);
  return true;
}

/** Reset a chat back to the default tenant. */
export function clearActiveCompany(chatId: string | number): void {
  active.delete(chatId);
}

/** Extract a candidate company key from a /company command argument. */
export function parseCompanyArg(arg: string | undefined): string | undefined {
  const v = (arg ?? "").trim().toLowerCase();
  return v.length > 0 ? v : undefined;
}
