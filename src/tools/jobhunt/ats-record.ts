/**
 * ATS fit record: what the tailoring pass learned about one row (pure, no I/O)
 * ===========================================================================
 * Stored as JSON text in `job_applications.ats_json`, shown as "ATS 62%, tailored yes" wherever the lane is shown,
 * and compared with APPLY_ATS_MIN_OVERLAP (a percent, 0 = record only) to hold a poor fit back from auto-send.
 * Missing skills are only ever listed here. They are never written into the CV.
 */

import type { LaneVerdict } from "./apply-lane.js";

export const MAX_ATS_SKILLS = 10;
const MAX_NOTE_CHARS = 200;

export interface AtsRecord {
  /** 0 to 1, CV-to-posting overlap before tailoring. Absent when nothing was measured. */
  readonly initialOverlapRatio?: number;
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly tailored: boolean;
  /** `failed <reason>` when tailoring failed. */
  readonly tailor?: string;
}

const pct = (ratio: number): number => Math.round(ratio * 100);

export function buildAtsRecord(input: {
  readonly ratio: number;
  readonly matched: readonly string[];
  readonly missing: readonly string[];
  readonly tailored: boolean;
  readonly tailor?: string;
}): AtsRecord {
  const measured = input.matched.length + input.missing.length > 0;
  return {
    ...(measured ? { initialOverlapRatio: input.ratio } : {}),
    matchedSkills: input.matched.slice(0, MAX_ATS_SKILLS),
    missingSkills: input.missing.slice(0, MAX_ATS_SKILLS),
    tailored: input.tailored,
    ...(input.tailor ? { tailor: input.tailor.slice(0, MAX_NOTE_CHARS) } : {}),
  };
}

/** Read `ats_json` back. Anything malformed is "no record". */
export function parseAts(raw: string | null | undefined): AtsRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AtsRecord> | null;
    if (typeof v !== "object" || v === null || typeof v.tailored !== "boolean") return null;
    const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    return {
      ...(typeof v.initialOverlapRatio === "number" ? { initialOverlapRatio: v.initialOverlapRatio } : {}),
      matchedSkills: list(v.matchedSkills),
      missingSkills: list(v.missingSkills),
      tailored: v.tailored,
      ...(typeof v.tailor === "string" ? { tailor: v.tailor } : {}),
    };
  } catch {
    // allow-failopen: an unreadable ats_json only means the card shows no ATS tag.
    return null;
  }
}

/** "ATS 62%, tailored yes" (or "ATS n/a, tailored no"); a failure note is appended when present. */
export function formatAtsTag(ats: AtsRecord | null | undefined): string {
  if (!ats) return "";
  const score = ats.initialOverlapRatio === undefined ? "n/a" : `${pct(ats.initialOverlapRatio)}%`;
  const note = ats.tailor ? ` (tailor: ${ats.tailor})` : "";
  return `ATS ${score}, tailored ${ats.tailored ? "yes" : "no"}${note}`;
}

/**
 * A row below the minimum goes to hand_off with the numbers and the top gaps. No gate when the minimum is 0 or
 * nothing was measured: an unmeasured row is not a poor fit.
 */
export function atsGate(verdict: LaneVerdict, ats: AtsRecord, minPercent: number): LaneVerdict {
  if (minPercent <= 0 || ats.initialOverlapRatio === undefined) return verdict;
  const have = pct(ats.initialOverlapRatio);
  if (have >= minPercent) return verdict;
  const missing = ats.missingSkills.slice(0, 3).join(", ") || "none listed";
  return { lane: "hand_off", reason: `ATS fit ${have}% below ${minPercent}%; missing: ${missing}` };
}
