/**
 * Apply queue: the tap counter
 * ============================
 * The queue page counts the taps the founder makes on a row's own card (Send, Save, a field focus; the swipe and the
 * Next button are navigation, not counted) and posts the number with the Send. The PR for #1326 states taps per
 * ready row from these rows (target 1). The row holds a row id, a count and the surface: no answer text, no name.
 */

import { TENANT } from "../core/config.js";
import { writeAuditEntry } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "gateway:apply-queue-taps" });
const MAX_TAPS = 50;

/** A whole number 0..50, or null (absent or nonsense: nothing is recorded, the send is unaffected). */
export function parseTaps(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_TAPS ? raw : null;
}

export const tapsKeyFor = (rowId: string, createdAt: number): string => `apply-queue-taps:${rowId}:${createdAt}`;

/** One action_log row per row and snapshot version, so a double tap records once. Never throws: the send must not depend on it. */
export async function recordQueueTaps(rowId: string, createdAt: number, taps: number): Promise<void> {
  try {
    await writeAuditEntry({
      action: "apply_queue_taps",
      idempotency_key: tapsKeyFor(rowId, createdAt),
      payload: { rowId, taps, surface: "queue" },
      tenant_id: TENANT,
    });
  } catch (err) {
    // allow-failopen: the tap count is a measurement; losing one row must never block or fail a send.
    log.warn({ rowId, err: (err as Error).message }, "apply queue: tap count not recorded");
  }
}
