/**
 * FounderOS — goals: inline-button payloads (pure)
 * ================================================
 * `goal:p:<id>`        Plan next step, for one goal
 * `goal:m:<i>`         a metric family chosen while adding a goal (i indexes METRIC_KEYS)
 * `goal:a:<i>:<arg>`   that family's argument (a profile id or an owner/repo)
 *
 * Telegram rejects the WHOLE keyboard when one `callback_data` exceeds 64 bytes, and a UUID alone is 36,
 * so a goal id travels as 22 characters of base64url (its 16 raw bytes). A payload that would not fit is
 * never built: one missing button is recoverable by typing, a refused `sendMessage` is not.
 *
 * A payload that comes back from a Telegram client is external input like any other: `decodeGoalCallback`
 * re-validates everything and returns null for whatever is malformed. The tap handler re-validates the
 * argument once more against the live registries before acting on it.
 */

import { METRIC_KEYS, type MetricKey } from "./metrics.js";
import { isSafeToken } from "./tokens.js";

export const GOAL_CALLBACK_PREFIX = "goal:";
/** Telegram's hard limit on `callback_data`, in BYTES. */
export const CALLBACK_DATA_MAX_BYTES = 64;

const ID_TOKEN_CHARS = 22;
const HEX = "0123456789abcdef";
const BASE64URL: ReadonlySet<string> = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");

function uuidToHex(uuid: string): string | null {
  if (uuid.length !== 36) return null;
  const hex = uuid.toLowerCase();
  const compact = [...hex].filter((c, i) => (i === 8 || i === 13 || i === 18 || i === 23 ? c === "-" : HEX.includes(c)));
  return compact.length === 36 ? compact.filter((c) => c !== "-").join("") : null;
}

/** A UUID → 22 characters, or null when it is not a UUID. */
export function encodeGoalId(uuid: string): string | null {
  const hex = uuidToHex(uuid);
  return hex === null ? null : Buffer.from(hex, "hex").toString("base64url");
}

/** The inverse of `encodeGoalId`; null for a token this code did not issue (wrong length, alphabet, or non-canonical bits). */
export function decodeGoalId(token: string): string | null {
  if (token.length !== ID_TOKEN_CHARS || ![...token].every((c) => BASE64URL.has(c))) return null;
  const raw = Buffer.from(token, "base64url");
  if (raw.length !== 16 || raw.toString("base64url") !== token) return null;
  const h = raw.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export type GoalCallback =
  | { readonly kind: "plan"; readonly goalId: string }
  | { readonly kind: "metric"; readonly family: MetricKey }
  | { readonly kind: "arg"; readonly family: MetricKey; readonly arg: string };

const familyIndex = (family: MetricKey): number => METRIC_KEYS.indexOf(family);

/** The payload for a button, or null when it cannot be built within 64 bytes (or is not well formed). */
export function encodeGoalCallback(cb: GoalCallback): string | null {
  let data: string | null;
  switch (cb.kind) {
    case "plan": {
      const token = encodeGoalId(cb.goalId);
      data = token === null ? null : `${GOAL_CALLBACK_PREFIX}p:${token}`;
      break;
    }
    case "metric":
      data = `${GOAL_CALLBACK_PREFIX}m:${familyIndex(cb.family)}`;
      break;
    case "arg":
      data = isSafeToken(cb.arg) ? `${GOAL_CALLBACK_PREFIX}a:${familyIndex(cb.family)}:${cb.arg}` : null;
      break;
  }
  return data !== null && Buffer.byteLength(data, "utf8") <= CALLBACK_DATA_MAX_BYTES ? data : null;
}

function familyFrom(text: string | undefined): MetricKey | null {
  if (text === undefined || text.length !== 1 || text < "0" || text > "9") return null;
  return METRIC_KEYS[Number(text)] ?? null;
}

/** A tapped payload → what it means; null for anything that is not a well-formed goal button. */
export function decodeGoalCallback(data: string): GoalCallback | null {
  if (!data.startsWith(GOAL_CALLBACK_PREFIX)) return null;
  const [kind, first, second, ...extra] = data.slice(GOAL_CALLBACK_PREFIX.length).split(":");
  if (extra.length > 0) return null;
  if (kind === "p" && first !== undefined && second === undefined) {
    const goalId = decodeGoalId(first);
    return goalId === null ? null : { kind: "plan", goalId };
  }
  if (kind === "m" && second === undefined) {
    const family = familyFrom(first);
    return family === null ? null : { kind: "metric", family };
  }
  if (kind === "a" && second !== undefined) {
    const family = familyFrom(first);
    return family === null || !isSafeToken(second) ? null : { kind: "arg", family, arg: second };
  }
  return null;
}
