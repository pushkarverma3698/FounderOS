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
 *  - current_focus and active_projects (written by /focus and /projects too) are
 *    bounded, and refused with the limit named rather than silently cut;
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
  "active_projects",
] as const;

/** Recognised keys whose value must be a non-empty factual string. */
const RECOGNISED_STRING_KEYS = ["notes"] as const;

/** Longest current_focus persisted (characters): it is quoted on every chat turn, so it stays one thought. */
export const CONTEXT_FOCUS_MAX_CHARS = 300;

/** Longest single active_projects entry persisted (characters). */
export const CONTEXT_PROJECT_MAX_CHARS = 200;

/** Most entries active_projects holds. */
export const CONTEXT_PROJECTS_MAX_ITEMS = 8;

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

/** One line, trimmed: a founder-typed value must not carry a newline into the "• key: value" lines it is rendered as. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Why active_projects is refused, or null. The founder is told the limit, never a silently cut list. */
function projectsProblem(items: readonly string[]): string | null {
  if (items.length > CONTEXT_PROJECTS_MAX_ITEMS) {
    return `too many entries (${items.length}, the limit is ${CONTEXT_PROJECTS_MAX_ITEMS})`;
  }
  const long = items.findIndex((item) => item.length > CONTEXT_PROJECT_MAX_CHARS);
  return long === -1
    ? null
    : `entry ${long + 1} is too long (${items[long]!.length} characters, the limit is ${CONTEXT_PROJECT_MAX_CHARS})`;
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
        .map((v) => (key === "active_projects" ? oneLine(v) : v.trim()));
      const problem = key === "active_projects" ? projectsProblem(items) : null;
      if (problem !== null) {
        rejected.push({ key, reason: problem });
        continue;
      }
      clean[key] = items;
      continue;
    }

    // The founder's own words: not put through the advisory filter below, which
    // exists for the model's free-text notes.
    if (key === "current_focus") {
      if (typeof value !== "string") {
        rejected.push({ key, reason: "expected a string" });
        continue;
      }
      const focus = oneLine(value);
      if (focus.length === 0) {
        rejected.push({ key, reason: "empty" });
        continue;
      }
      if (focus.length > CONTEXT_FOCUS_MAX_CHARS) {
        rejected.push({ key, reason: `too long (${focus.length} characters, the limit is ${CONTEXT_FOCUS_MAX_CHARS})` });
        continue;
      }
      clean[key] = focus;
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
