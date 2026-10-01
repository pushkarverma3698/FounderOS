/**
 * FounderOS — founder_context per-key dates (pure, no DB)
 * ========================================================
 * agents.founder_context is one JSONB blob per tenant with a single row-level
 * `last_updated`. Until 2026-09-29 read_context printed that one date under every
 * value, so a value the June seed wrote read as confirmed the day the row last
 * moved (2026-09-28), and the bot quoted June's plan as the founder's current focus.
 *
 * `context_meta` records the date per key, inside the same JSONB (no migration):
 *
 *   { [key]: { at: <ISO timestamp>, source: "founder" | "seed" | "system" } }
 *
 * The value and its date land in one write, so they cannot disagree. `source` says
 * who wrote the value: the founder (update_context, /focus, /projects), the deploy
 * seed, or code that owns the value outright. A key with no entry has an UNKNOWN
 * date and is rendered that way (src/tools/context-render.ts): missing data fails
 * loud, it is never read as fresh.
 *
 * Nothing here reads a clock or a database: `now` is always an argument.
 */

/** founder_context key holding the per-key dates. Bookkeeping: never rendered as context. */
export const CONTEXT_META_KEY = "context_meta";

/** The mark read_context puts on a value that may be stale; the planner rule refers to it by this name. */
export const CONTEXT_STALE_MARKER = "⚠";

/** Who can write a value: the founder, the deploy seed, or code that owns the value. */
export const CONTEXT_SOURCES = ["founder", "seed", "system"] as const;
export type ContextSource = (typeof CONTEXT_SOURCES)[number];

export interface ContextMetaEntry {
  /** ISO timestamp the value was last written or confirmed. */
  readonly at: string;
  readonly source: ContextSource;
}

export type ContextMetaEntries = Readonly<Record<string, ContextMetaEntry>>;

export interface ReadContextMeta {
  /** Every well-formed entry, by key. */
  readonly entries: ContextMetaEntries;
  /** Why some or all of the stored meta was ignored; empty when it was healthy or absent. */
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function asEntry(value: unknown): ContextMetaEntry | null {
  if (!isRecord(value)) return null;
  const { at, source } = value;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  const known = CONTEXT_SOURCES.find((candidate) => candidate === source);
  return known === undefined ? null : { at, source: known };
}

/**
 * The dates stored in a row. Never throws: a `context_meta` that is not an object
 * yields no entries and one problem; a broken entry is dropped and named in one
 * problem, and its healthy neighbours are kept. Callers log the problems.
 */
export function readContextMeta(ctx: Readonly<Record<string, unknown>>): ReadContextMeta {
  const raw = ctx[CONTEXT_META_KEY];
  if (raw === undefined) return { entries: {}, problems: [] };
  if (!isRecord(raw)) {
    return { entries: {}, problems: [`${CONTEXT_META_KEY} is ${kindOf(raw)}, not an object of { at, source } per key`] };
  }
  const parsed = Object.entries(raw).map(([key, value]) => [key, asEntry(value)] as const);
  const broken = parsed.filter(([, entry]) => entry === null).map(([key]) => key);
  // fromEntries defines own properties: a stored key named "__proto__" must not reach the prototype.
  const entries = Object.fromEntries(parsed.filter((pair): pair is readonly [string, ContextMetaEntry] => pair[1] !== null));
  const problems = broken.length > 0 ? [`${CONTEXT_META_KEY} entries ignored, not { at, source }: ${broken.join(", ")}`] : [];
  return { entries, problems };
}

/** A copy of `entries` with each of `keys` dated `now` and attributed to `source`. */
export function stampContextMeta(
  entries: ContextMetaEntries,
  keys: readonly string[],
  source: ContextSource,
  now: Date,
): ContextMetaEntries {
  const at = now.toISOString();
  return { ...entries, ...Object.fromEntries(keys.map((key): [string, ContextMetaEntry] => [key, { at, source }])) };
}

/** A copy of `entries` keeping only keys that still have a value, so a deleted value leaves no orphan date. */
export function pruneContextMeta(entries: ContextMetaEntries, presentKeys: Iterable<string>): ContextMetaEntries {
  const present = new Set(presentKeys);
  return Object.fromEntries(Object.entries(entries).filter(([key]) => present.has(key)));
}
