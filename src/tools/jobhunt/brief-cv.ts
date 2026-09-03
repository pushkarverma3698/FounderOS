/**
 * FounderOS — which CV a posting is compared against
 * ==================================================
 * One CV per track, read once per brief rather than once per row, plus the
 * honest handling of a CV that is not there.
 *
 * Split out of daily-brief.ts to keep that file inside the 400-line budget. It
 * earns its own file anyway: "which document do we score this posting against"
 * is a distinct question from "which postings are actionable today", and the
 * answer has its own failure mode — a missing CV scores every posting at 0
 * overlap, so the brief still renders a confident-looking ORDER built from no
 * comparison at all.
 */

import { childLogger } from "../../infra/logger.js";
import { readFullCvText } from "../career.js";
import { TRACK_PRIORITY } from "./tracks.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";

const log = childLogger({ module: "jobhunt:brief-cv" });

/**
 * Per-track CV text, read once per brief rather than once per row.
 *
 * Iterates `profile.trackPriority` (not the hardcoded tech TRACK_PRIORITY), so
 * a non-tech profile (e.g. Wife's finance tracks) reads its own CVs. Without
 * this, every profile's brief iterated Pushkar's 4 tech tracks regardless of
 * which candidate the brief was being built for.
 *
 * Returns the tracks it could NOT read alongside the ones it could. Without that
 * list the failure is silent: a missing CV scores every posting at 0 overlap, so
 * the brief still renders a confident-looking order built from no comparison at
 * all. A log line does not reach the founder; a brief line does.
 */
export function loadTrackCvs(
  profile: JobSearchProfile = getProfile(),
): { cvs: Map<string, string>; unreadable: string[] } {
  const cvs = new Map<string, string>();
  const unreadable: string[] = [];
  const trackIds = profile.trackPriority.length > 0 ? profile.trackPriority : TRACK_PRIORITY;

  for (const trackId of trackIds) {
    const trackConfig = profile.tracks[trackId];
    const explicitPaths = trackConfig?.cvPath ? [trackConfig.cvPath] : undefined;
    const cv = readFullCvText(trackId, explicitPaths);
    if (cv.ok) cvs.set(trackId, cv.text);
    else {
      unreadable.push(trackId);
      log.warn({ track: trackId, error: cv.error }, "Track CV unreadable — overlap unavailable");
    }
  }

  // A row whose title matched no track is stored as "unclassified", and every
  // row screened before tracks existed carries that value. Without an entry here
  // the map lookup misses, the CV text is "", and EVERY such row scores 0/N —
  // a ranking built from no comparison, printed with no warning. Production's
  // first real brief showed "0/21 skills" on all three rows for exactly this
  // reason. The profile's base CV is the honest comparison for a row with no
  // track, and it is what `readFullCvText` returns when asked for no track.
  const masterPaths = profile.baseCvPath ? [profile.baseCvPath] : undefined;
  const master = readFullCvText(undefined, masterPaths);
  if (master.ok) cvs.set(UNCLASSIFIED_TRACK, master.text);
  else {
    unreadable.push(UNCLASSIFIED_TRACK);
    log.warn({ error: master.error }, "Master CV unreadable — untracked rows score 0 overlap");
  }

  return { cvs, unreadable };
}

/** The `track` column's default: a title that matched no track's phrases. */
export const UNCLASSIFIED_TRACK = "unclassified";
