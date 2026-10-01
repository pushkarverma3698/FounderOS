/**
 * Shared fixtures for the jobhunt findings tests (analyzer, issue body, dispatch,
 * orchestration). One source of "what a healthy lane and a broken one look like",
 * so the tests can never quietly disagree about the shape of the input.
 */

import type {
  ApplyActivityRow,
  IngestRunRow,
  JobhuntSnapshot,
  LaneHeartbeatRow,
  NewPostingRow,
} from "../../src/evolution/analyzers/jobhunt.js";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** 09:30 IST on the day the plan was written: the hour the daily cron fires. */
export const NOW = new Date("2026-09-29T04:00:00.000Z");
export const ago = (ms: number, from: Date = NOW): Date => new Date(from.getTime() - ms);

/** `count` postings for one platform, spread evenly between two ages (hours before `from`). */
export function postings(
  platform: string | null,
  count: number,
  span: { fromHoursAgo: number; toHoursAgo: number },
  opts: { hasFormLink?: boolean; from?: Date } = {},
): NewPostingRow[] {
  const from = opts.from ?? NOW;
  const label = platform ?? "own-domain";
  return Array.from({ length: count }, (_, i) => {
    const hoursAgo =
      count === 1
        ? span.fromHoursAgo
        : span.fromHoursAgo - ((span.fromHoursAgo - span.toHoursAgo) * i) / (count - 1);
    return {
      createdAt: ago(hoursAgo * HOUR, from),
      company: `Company ${label} ${i}`,
      title: `Role ${label} ${i}`,
      url: `https://${label}.example.test/jobs/${i}`,
      platform,
      hasFormLink: opts.hasFormLink ?? true,
    };
  });
}

/** `count` free-sweep ledger rows across the last 24h; the first `failing` name `platform` as failing. */
export function sweepRuns(
  count: number,
  failing: { platform: string; runs: number } | null = null,
  from: Date = NOW,
): IngestRunRow[] {
  return Array.from({ length: count }, (_, i) => ({
    createdAt: ago(((i + 0.5) * 24 * HOUR) / count, from),
    error:
      failing && i < failing.runs
        ? `12 board(s) failed: greenhouse HTTP 404 ×9; ${failing.platform} HTTP 429 ×3`
        : null,
  }));
}

export const QUIET_HEARTBEATS: LaneHeartbeatRow[] = [
  { profileId: "wife-nl-finance", candidateName: "Tashi Goyal", zeroPassStreak: 0, lastFunnel: null },
];
export const ACTING: ApplyActivityRow[] = [
  { profileId: "wife-nl-finance", candidateName: "Tashi Goyal", doToday: 4, stretch: 2, ask: 3, applied: 5, skipped: 1 },
];

/**
 * A healthy lane: ashby, greenhouse and lever each hold a steady baseline and are
 * still producing in the last 24h; 96 sweep runs; nothing failing.
 */
export function healthy(over: Partial<JobhuntSnapshot> = {}): JobhuntSnapshot {
  const rows: NewPostingRow[] = [];
  for (const platform of ["ashby", "greenhouse", "lever"]) {
    rows.push(...postings(platform, 100, { fromHoursAgo: 190, toHoursAgo: 26 }));
    rows.push(...postings(platform, 14, { fromHoursAgo: 23, toHoursAgo: 1 }));
  }
  return {
    ingestRuns: sweepRuns(96),
    laneHeartbeats: QUIET_HEARTBEATS,
    newPostings: rows,
    applyActivity: ACTING,
    ...over,
  };
}

/** The same lane with `platform` dead for the last 24h: its baseline stays, its window rows go. */
export function withSilent(platform: string, over: Partial<JobhuntSnapshot> = {}): JobhuntSnapshot {
  const base = healthy();
  return {
    ...base,
    newPostings: base.newPostings.filter(
      (p) => !(p.platform === platform && p.createdAt.getTime() > NOW.getTime() - DAY),
    ),
    ...over,
  };
}

