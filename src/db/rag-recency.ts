/**
 * Recency weighting for brain_memories ranking.
 * =============================================
 * 2026-10-04 audit: 310 of the 763 plan chunks were over 30 days old and ranked exactly like last week's, so "what is
 * the plan for X" could be answered from a plan that had since been replaced.
 *
 * The date comes from the document's own file name (`docs/plans/2026-10-03-foo.md`). `created_at` cannot be used:
 * `brain:sync` deletes and re-inserts a source's chunks, so it only records when the sync last ran. A document with no
 * date in its name (an ADR, CLAUDE.md, a rule) is never aged: those are meant to be long-lived.
 *
 * The weight multiplies the fused RRF score, so it breaks near-ties toward the newer document without overriding a
 * clearly better match. Pure arithmetic, no I/O: the clock is passed in.
 */

import { RRF_K } from "./rrf.js";

/** Share of its score a dated document keeps once it is `RECENCY_FULL_DECAY_DAYS` old or older. */
export const RECENCY_FLOOR = 0.7;
export const RECENCY_FULL_DECAY_DAYS = 90;

const MS_PER_DAY = 86_400_000;
/** `YYYY-MM-DD` at the start of the file name, followed by a separator or the end of the name. */
const FILE_DATE = /^(\d{4})-(\d{2})-(\d{2})(?=[-.]|$)/;

/** Date in the document's file name as UTC midnight ms, or null when it has none. */
export function docDateMs(metadata: Record<string, unknown> | null | undefined): number | null {
  const path = metadata?.source_path ?? metadata?.source_file;
  if (typeof path !== "string") return null;
  const name = path.slice(path.lastIndexOf("/") + 1);
  const m = FILE_DATE.exec(name);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Date.UTC rolls 2026-13-45 over into a real date; reject anything that did not round-trip.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return ms;
}

/** 1 for today, falling in a straight line to `RECENCY_FLOOR` at `RECENCY_FULL_DECAY_DAYS`. A future date counts as today. */
export function recencyWeight(ageDays: number): number {
  if (ageDays <= 0) return 1;
  if (ageDays >= RECENCY_FULL_DECAY_DAYS) return RECENCY_FLOOR;
  return 1 - ((1 - RECENCY_FLOOR) * ageDays) / RECENCY_FULL_DECAY_DAYS;
}

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Re-order already-scored hits by `score × recencyWeight`, best first. Equal adjusted scores keep their incoming order.
 * Does not mutate `scored`.
 */
export function orderWithRecency<T extends { metadata: Record<string, unknown> }>(
  scored: readonly Scored<T>[],
  nowMs: number,
): T[] {
  return scored
    .map(({ item, score }, index) => {
      const dated = docDateMs(item.metadata);
      const weight = dated === null ? 1 : recencyWeight((nowMs - dated) / MS_PER_DAY);
      return { item, index, adjusted: score * weight };
    })
    .sort((a, b) => b.adjusted - a.adjusted || a.index - b.index)
    .map((s) => s.item);
}

/** RRF-style score for a list that came from one signal only: position 0 is the best. */
export function rankScored<T>(ranked: readonly T[]): Scored<T>[] {
  return ranked.map((item, rank) => ({ item, score: 1 / (RRF_K + rank + 1) }));
}
