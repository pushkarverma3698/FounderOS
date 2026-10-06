/**
 * Mac capture run planner (AG-027). Pure: given candidate files (with a lazy builder), the previous state and a cap,
 * decide which records to emit and what the next state is. The collector does the file I/O.
 */
import { hashRecord, secretsIn, type DigestRecord } from "./brain-digest.js";

export interface StateEntry {
  readonly mtime: number;
  readonly hash: string;
}
export interface CaptureState {
  readonly version: 1;
  readonly entries: Readonly<Record<string, StateEntry>>;
}

export const EMPTY_STATE: CaptureState = { version: 1, entries: {} };

/** A broken state file means "capture everything again": the VPS upserts, so that is safe. */
export function parseState(text: string | null): CaptureState {
  if (!text) return EMPTY_STATE;
  try {
    const raw = JSON.parse(text) as Partial<CaptureState>;
    return raw.version === 1 && raw.entries && typeof raw.entries === "object" ? { version: 1, entries: raw.entries } : EMPTY_STATE;
  } catch {
    return EMPTY_STATE; // allow-failopen: re-capturing is idempotent
  }
}

export interface Candidate {
  /** Stable key for the state file: a path or a conversation id. */
  readonly key: string;
  /** Shown in the run summary when the record is dropped. A path or id, never content. */
  readonly label: string;
  readonly mtimeMs: number;
  /** Reads and digests the source. Called only when mtime says the source changed. */
  readonly build: () => DigestRecord | null;
}

export interface DroppedRecord {
  readonly label: string;
  readonly patterns: readonly string[];
}

export interface RunPlan {
  readonly records: readonly DigestRecord[];
  readonly nextState: CaptureState;
  readonly dropped: readonly DroppedRecord[];
  readonly unchanged: number;
  /** Changed sources left for a later run because the cap was reached. */
  readonly deferred: number;
  /** Keys of candidates whose record was dropped for a secret. */
  readonly droppedKeys: ReadonlySet<string>;
}

/** Newest first, so a first backfill surfaces recent work before old work. */
export function planRun(candidates: readonly Candidate[], state: CaptureState, cap: number): RunPlan {
  const records: DigestRecord[] = [];
  const dropped: DroppedRecord[] = [];
  const droppedKeys = new Set<string>();
  const next: Record<string, StateEntry> = {};
  let unchanged = 0;
  let deferred = 0;

  for (const c of [...candidates].sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const prev = state.entries[c.key];
    if (prev && prev.mtime === c.mtimeMs) {
      next[c.key] = prev;
      unchanged += 1;
      continue;
    }
    if (records.length >= cap) {
      deferred += 1;
      continue;
    }
    const record = c.build();
    if (!record) {
      next[c.key] = { mtime: c.mtimeMs, hash: "empty" };
      continue;
    }
    const patterns = secretsIn(record);
    if (patterns.length > 0) {
      dropped.push({ label: c.label, patterns });
      droppedKeys.add(c.key);
      continue;
    }
    const hash = hashRecord(record);
    next[c.key] = { mtime: c.mtimeMs, hash };
    if (prev?.hash === hash) {
      unchanged += 1;
    } else {
      records.push(record);
    }
  }
  return { records, nextState: { version: 1, entries: next }, dropped, unchanged, deferred, droppedKeys };
}
