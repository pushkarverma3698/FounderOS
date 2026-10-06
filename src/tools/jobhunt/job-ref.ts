/**
 * FounderOS — a role's stable short id
 * =================================
 * An alert used to print `/draft 4`. Four is a position in a list that is re-ranked every sweep, so three days
 * later `/draft 4` was a different company. The id is the role: it is the first characters of the row's own
 * uuid, so it cannot move, needs no column and no backfill, and exists for every row already in prod.
 *
 * The leading `j` is what keeps an id from ever being read as a row number: a short id made only of digits
 * would otherwise parse as position 12345678.
 * Pure functions. The lookup lives in db/job-ref-queries.ts.
 */

/** Hex characters printed after the `j`. 7 gives 268M ids; at prod volume a collision is a rare, loud refusal. */
export const JOB_ID_HEX_CHARS = 7;

/** The shortest prefix `parseJobId` accepts. Shorter would match too many roles to be an address. */
export const JOB_ID_MIN_HEX_CHARS = JOB_ID_HEX_CHARS;

/** A uuid has 32 hex characters. */
export const JOB_ID_MAX_HEX_CHARS = 32;

const ID_PREFIX_LETTER = "j";
const HEX_DIGITS = "0123456789abcdef";

const isHex = (s: string): boolean => s.split("").every((c) => HEX_DIGITS.includes(c));

/** The id an alert prints for a row: `j` plus the first hex characters of its uuid. */
export function shortJobId(rowId: string): string {
  const hex = rowId.split("-").join("").toLowerCase();
  return ID_PREFIX_LETTER + hex.slice(0, JOB_ID_HEX_CHARS);
}

/**
 * The hex prefix a typed id stands for, or null when the text is not an id at all.
 * A row number, a word, a too-short prefix and a prefix with a non-hex character are all null: never a guess.
 */
export function parseJobId(raw: string): string | null {
  const token = raw.trim().toLowerCase();
  if (!token.startsWith(ID_PREFIX_LETTER)) return null;
  const hex = token.slice(ID_PREFIX_LETTER.length);
  if (hex.length < JOB_ID_MIN_HEX_CHARS || hex.length > JOB_ID_MAX_HEX_CHARS) return null;
  return isHex(hex) ? hex : null;
}

/** Lay 32 hex characters out as a uuid: 8-4-4-4-12. */
function asUuid(hex32: string): string {
  const groups = [hex32.slice(0, 8), hex32.slice(8, 12), hex32.slice(12, 16), hex32.slice(16, 20), hex32.slice(20)];
  return groups.join("-");
}

/**
 * The uuid range every id starting with `hexPrefix` falls inside, so the lookup is one indexed range scan
 * on the primary key instead of a cast of every row to text.
 */
export function idPrefixRange(hexPrefix: string): { readonly lo: string; readonly hi: string } {
  const pad = JOB_ID_MAX_HEX_CHARS - hexPrefix.length;
  return {
    lo: asUuid(hexPrefix + "0".repeat(pad)),
    hi: asUuid(hexPrefix + "f".repeat(pad)),
  };
}

/** Callback prefix of every job button. Short: Telegram caps callback_data at 64 bytes and a uuid is 36. */
export const JOB_CALLBACK_PREFIX = "jh:";

export type JobAction = "draft" | "applied";

/** The payload a 📝 Draft / ✅ I applied button carries. Lives here so the digest (tools) and the handler (gateway) share one format. */
export function jobCallbackData(action: JobAction, rowId: string): string {
  return `${JOB_CALLBACK_PREFIX}${action === "draft" ? "d" : "a"}:${rowId}`;
}
