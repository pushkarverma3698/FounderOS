/**
 * ATS score band vs outcome for sent applications (pure; the data to set APPLY_ATS_MIN_OVERLAP from)
 * ===================================================================================================
 * Read-only. A row counts when it was sent (`applied_at` set). The outcome comes from `stage`, the only outcome
 * column: replied -> reply, rejected -> reject, interview -> interview (no code writes it today, so it stays 0),
 * anything else -> none. The score is the pre-tailoring overlap, the number `atsGate` compares.
 */

import { parseAts } from "./ats-record.js";

export const BANDS = ["<40", "40-60", "60-80", "80+", "unscored"] as const;
export const OUTCOMES = ["reply", "interview", "reject", "none"] as const;
export type Band = (typeof BANDS)[number];
export type Outcome = (typeof OUTCOMES)[number];
export type OutcomeTable = Record<Band, Record<Outcome, number>>;

export interface OutcomeRow {
  readonly applied_at: Date | string | null;
  readonly stage: string;
  readonly ats_json: string | null;
}

export function bandOf(percent: number | undefined): Band {
  if (percent === undefined) return "unscored";
  if (percent < 40) return "<40";
  if (percent < 60) return "40-60";
  if (percent < 80) return "60-80";
  return "80+";
}

export function outcomeOf(stage: string): Outcome {
  if (stage === "replied") return "reply";
  if (stage === "interview") return "interview";
  if (stage === "rejected") return "reject";
  return "none";
}

export function groupByBand(rows: readonly OutcomeRow[]): OutcomeTable {
  const table = Object.fromEntries(BANDS.map((b) => [b, Object.fromEntries(OUTCOMES.map((o) => [o, 0]))])) as OutcomeTable;
  for (const row of rows) {
    if (!row.applied_at) continue;
    const ratio = parseAts(row.ats_json)?.initialOverlapRatio;
    table[bandOf(ratio === undefined ? undefined : Math.round(ratio * 100))][outcomeOf(row.stage)] += 1;
  }
  return table;
}

export function formatTable(table: OutcomeTable): string {
  const head = ["ATS band", ...OUTCOMES, "sent", "reply%"].join("\t");
  const lines = BANDS.map((b) => {
    const counts = OUTCOMES.map((o) => table[b][o]);
    const sent = counts.reduce((a, c) => a + c, 0);
    const rate = sent === 0 ? "-" : `${Math.round(((table[b].reply + table[b].interview) / sent) * 100)}%`;
    return [b, ...counts, sent, rate].join("\t");
  });
  return [head, ...lines].join("\n");
}
