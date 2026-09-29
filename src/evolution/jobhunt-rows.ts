/**
 * Evolution Engine — stored rows into what the jobhunt analyzer reads.
 * =====================================================================
 * The mapping half of the collector (`collect-jobhunt.ts` is the query half), split
 * out so it is testable with array literals and so nothing here touches a database.
 *
 * TWO DECISIONS LIVE HERE, and both decide what the analyzer's findings mean:
 *
 * 1. WHICH PLATFORM A POSTING BELONGS TO. From the recogniser first
 *    (`extractBoardToken`, the function the board harvest and `/draft` already use),
 *    then from the host. The host fallback is what lets a URL that sits on a
 *    platform's own domain but that the recogniser cannot read count AGAINST that
 *    platform (the apply-link defect). A posting served from an employer's own domain
 *    belongs to NO platform: the 2026-09-28 audit measured 17.8% of postings with no
 *    form link by design (white-labelled Greenhouse and Recruitee boards), and
 *    counting those would file an unfixable issue every morning.
 *
 * 2. WHETHER A POSTING HAS A FORM LINK. `getApplyUrl`, the same function `/draft`
 *    and `tailor_cv` call. A second implementation would measure something the
 *    founder never experiences, and would drift. (It lives in apply-packet.ts, whose
 *    file also holds the tailoring code, which is why this module is loaded only by
 *    the collector and never statically by the check itself.)
 */

import { getApplyUrl } from "../tools/jobhunt/apply-packet.js";
import { extractBoardToken } from "../tools/jobhunt/board-token.js";
import type { FreeFunnel } from "../tools/jobhunt/free-ingest.js";
import type {
  ApplyActivityRow,
  IngestRunRow,
  LaneHeartbeatRow,
  NewPostingRow,
} from "./analyzers/jobhunt.js";

/**
 * The `feed` value the free lane writes to `job_ingest_runs` (free-ingest.ts calls
 * `recordQueryCost({ feed: "free-ats", pool: "free-boards" })`). A test reads that
 * file so a rename fails a test instead of blinding the check.
 */
export const FREE_LANE_FEED = "free-ats";

/**
 * The hosts each platform serves postings from. Keyed exactly like `ADAPTERS`: a test
 * fails when a platform gains an adapter without an entry here, so it cannot ship unmonitored.
 */
export const PLATFORM_HOST_SUFFIXES: Readonly<Record<string, readonly string[]>> = {
  greenhouse: ["greenhouse.io"],
  lever: ["lever.co"],
  ashby: ["ashbyhq.com"],
  recruitee: ["recruitee.com"],
  smartrecruiters: ["smartrecruiters.com"],
  workable: ["workable.com"],
  personio: ["personio.com", "personio.de"],
  workday: ["myworkdayjobs.com"],
  teamtailor: ["teamtailor.com"],
  bamboohr: ["bamboohr.com"],
};

/** The platform a posting URL belongs to, or null when it is served from an employer's own domain. Never throws. */
export function platformOfUrl(url: string): string | null {
  const token = extractBoardToken(url);
  if (token) return token.ats;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // allow-failopen: a URL that does not parse belongs to no platform; that is the answer, not an error to hide.
    return null;
  }
  for (const [platform, suffixes] of Object.entries(PLATFORM_HOST_SUFFIXES)) {
    if (suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) return platform;
  }
  return null;
}

/** Whether `/draft` would hand out an application-form link for this posting. Never throws. */
function hasFormLink(url: string, company: string): boolean {
  try {
    return getApplyUrl(url, company) !== null;
  } catch {
    // allow-failopen: a URL the recogniser cannot even process is one it does not recognise, which is the verdict.
    return false;
  }
}

export function toNewPostingRow(raw: {
  readonly createdAt: Date | null;
  readonly company: string;
  readonly title: string;
  readonly url: string | null;
}): NewPostingRow | null {
  // Without a date it cannot be windowed, and without a URL it cannot be quoted or classified.
  if (!raw.createdAt || !raw.url) return null;
  return {
    createdAt: raw.createdAt,
    company: raw.company,
    title: raw.title,
    url: raw.url,
    platform: platformOfUrl(raw.url),
    hasFormLink: hasFormLink(raw.url, raw.company),
  };
}

export function toIngestRunRow(raw: { readonly createdAt: Date | null; readonly error: string | null }): IngestRunRow | null {
  return raw.createdAt ? { createdAt: raw.createdAt, error: raw.error } : null;
}

const FUNNEL_KEYS = ["seen", "undated", "stale", "offTrack", "offMarket", "known", "bodyless", "screened"] as const;

/** The heartbeat's jsonb funnel, or null when it is not the shape the lane writes. */
function toFunnel(value: unknown): FreeFunnel | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!FUNNEL_KEYS.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]))) return null;
  return Object.fromEntries(FUNNEL_KEYS.map((key) => [key, record[key]])) as unknown as FreeFunnel;
}

export function toHeartbeatRow(
  raw: { readonly profileId: string; readonly zeroPassStreak: number; readonly lastFunnel: unknown },
  names: ReadonlyMap<string, string>,
): LaneHeartbeatRow {
  const candidateName = names.get(raw.profileId);
  return {
    profileId: raw.profileId,
    ...(candidateName ? { candidateName } : {}),
    zeroPassStreak: raw.zeroPassStreak,
    lastFunnel: toFunnel(raw.lastFunnel),
  };
}

/** A count from the database (Postgres returns `count(*)` as a string), or a thrown error naming the field. */
function asCount(value: unknown, field: string): number {
  const n = Number(value);
  // One NaN would silently turn every comparison downstream false and read as "acting". Loud instead.
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field} is not a count: ${String(value)}`);
  return n;
}

export function toActivityRow(
  raw: {
    readonly profileId: string;
    readonly doToday: unknown;
    readonly stretch: unknown;
    readonly ask: unknown;
    readonly applied: unknown;
    readonly skipped: unknown;
  },
  names: ReadonlyMap<string, string>,
): ApplyActivityRow {
  const candidateName = names.get(raw.profileId);
  return {
    profileId: raw.profileId,
    ...(candidateName ? { candidateName } : {}),
    doToday: asCount(raw.doToday, "doToday"),
    stretch: asCount(raw.stretch, "stretch"),
    ask: asCount(raw.ask, "ask"),
    applied: asCount(raw.applied, "applied"),
    skipped: asCount(raw.skipped, "skipped"),
  };
}
