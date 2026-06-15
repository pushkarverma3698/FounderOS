/**
 * FounderOS — Founder Context Write Guard
 * =======================================
 * Deterministic (rule #16) validation for `update_context` writes into
 * `founder_context`.
 *
 * Why this exists: a prod hallucination on 2026-06-15 was root-caused to a junk
 * note the model wrote into `founder_context.notes`
 *   "A setup combining GBrain, MemSearch … would be highly effective …"
 * which `read_context` then surfaced on every relevant turn as authoritative
 * "Current business context". The `update_context` schema was
 * `z.record(z.unknown())` — it accepted any key and any value.
 *
 * This guard enforces, as a pure function with unit tests:
 *  - only recognised keys are persisted (unknown keys are dropped, not stored);
 *  - recognised keys hold the correct type (arrays of strings / a string);
 *  - `notes` records factual STATE, not advisory/speculative recommendations
 *    (the junk note was advisory — "would be highly effective").
 *
 * It never throws (fail-safe, rule #19.5): bad input yields an empty `clean`
 * plus a `rejected` list the caller surfaces to the founder.
 */

/** Recognised keys whose value must be an array of non-empty strings. */
const RECOGNISED_ARRAY_KEYS = [
  "active_clients",
  "open_deals",
  "current_priorities",
  "next_actions",
] as const;

/** Recognised keys whose value must be a non-empty factual string. */
const RECOGNISED_STRING_KEYS = ["notes"] as const;

/**
 * Markers that signal an advisory/speculative recommendation rather than a
 * factual record of business state. Context is a record of what IS, not what
 * the model thinks the founder SHOULD do — recommendations belong in a reply,
 * never in durable, always-injected context.
 */
const ADVISORY_MARKERS: readonly RegExp[] = [
  /\bwould be\b/i,
  /\bcould be\b/i,
  /\bshould consider\b/i,
  /\bshould\b/i,
  /\bhighly effective\b/i,
  /\bmight\b/i,
  /\brecommend/i,
  /\bi suggest\b/i,
  /\bit would help\b/i,
];

export interface ContextRejection {
  readonly key: string;
  readonly reason: string;
}

export interface SanitizeResult {
  /** Validated keys safe to persist. */
  readonly clean: Record<string, unknown>;
  /** Keys dropped, with a human-readable reason (surfaced to the founder). */
  readonly rejected: ContextRejection[];
}

function isArrayKey(key: string): boolean {
  return (RECOGNISED_ARRAY_KEYS as readonly string[]).includes(key);
}

function isStringKey(key: string): boolean {
  return (RECOGNISED_STRING_KEYS as readonly string[]).includes(key);
}

/**
 * Validate and clean a founder-context update payload.
 * Pure, deterministic, never throws.
 */
export function sanitizeContextUpdates(
  updates: Record<string, unknown>,
): SanitizeResult {
  const clean: Record<string, unknown> = {};
  const rejected: ContextRejection[] = [];

  if (updates === null || typeof updates !== "object") {
    return { clean, rejected };
  }

  for (const [key, value] of Object.entries(updates)) {
    if (isArrayKey(key)) {
      if (!Array.isArray(value)) {
        rejected.push({ key, reason: "expected an array of strings" });
        continue;
      }
      const items = value
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.trim());
      clean[key] = items;
      continue;
    }

    if (isStringKey(key)) {
      if (typeof value !== "string") {
        rejected.push({ key, reason: "expected a string" });
        continue;
      }
      const note = value.trim();
      if (note.length === 0) {
        rejected.push({ key, reason: "empty" });
        continue;
      }
      if (ADVISORY_MARKERS.some((re) => re.test(note))) {
        rejected.push({
          key,
          reason:
            "advisory/speculative — context records factual business state, not recommendations",
        });
        continue;
      }
      clean[key] = note;
      continue;
    }

    rejected.push({ key, reason: "unrecognised key" });
  }

  return { clean, rejected };
}
