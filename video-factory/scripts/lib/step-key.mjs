/**
 * Video Factory — canonical receipt step-key (single source of truth).
 *
 * This is the ONE implementation of the idempotency key (audit F4). Both the
 * executor (produce.mjs) and the TypeScript planner (src/tools/video-production.ts)
 * must derive byte-identical keys or receipts silently double-spend or go stale.
 * A parity unit test (tests/unit/tools/video-receipt-key.test.ts) imports THIS
 * file and asserts it matches the TS `stepKey` for representative steps.
 *
 * Keep the algorithm dependency-free and pure — it is hashed, not versioned.
 */

/** 32-bit FNV-1a — identical to src/tools/video-shotlist.ts `fnv1a`. */
export function fnv1a(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic content key for a production step. */
export function stepKey(step) {
  return fnv1a(JSON.stringify({ id: step.id, kind: step.kind, params: step.params, produces: step.produces })).toString(16);
}
