/**
 * Pick the track base CV that already fits a posting best (pure, no I/O besides the injected reader)
 * ===================================================================================================
 * The row's `track` is a screening guess. Tailoring starts from the base CV whose own keywords overlap the
 * posting most (the same `overlapScore`/`compareOverlap` the brief ranks with). The row's track wins ties, and
 * a track with no CV of its own is skipped, never replaced by the shared master, so a pick is always a real file.
 */

import { cvPathsForTrack, type CvTextResult } from "../career.js";
import { DEFAULT_PROFILE_ID, type JobSearchProfile } from "./profile-config.js";
import { compareOverlap, overlapScore } from "./overlap.js";

export interface TrackCv {
  readonly track: string;
  readonly text: string;
}

/** Highest overlap wins; the preferred track keeps a tie. Null when there are no candidates. */
export function pickClosestTrack(
  description: string,
  cvs: readonly TrackCv[],
  preferred: string,
  dictionaryName = "tech",
): TrackCv | null {
  let best: { cv: TrackCv; score: ReturnType<typeof overlapScore> } | null = null;
  for (const cv of cvs) {
    const score = overlapScore(description, cv.text, dictionaryName);
    if (!best) best = { cv, score };
    else {
      const cmp = compareOverlap(score, best.score);
      if (cmp < 0 || (cmp === 0 && cv.track === preferred)) best = { cv, score };
    }
  }
  return best?.cv ?? null;
}

/** The CV file a track owns: the profile's explicit path, or (default profile only) PERSONAL_CV_DIR/<track>/cv.md. */
export function ownCvPath(profile: JobSearchProfile, track: string): string | undefined {
  const explicit = profile.tracks[track]?.cvPath;
  if (explicit) return explicit;
  return profile.id === DEFAULT_PROFILE_ID ? cvPathsForTrack(track)[0] : undefined;
}

/** Every track CV that can be read. Unreadable or missing ones are left out. */
export function loadTrackCvs(
  profile: JobSearchProfile,
  read: (track: string, paths: readonly string[]) => CvTextResult,
): TrackCv[] {
  const out: TrackCv[] = [];
  for (const track of Object.keys(profile.tracks)) {
    const p = ownCvPath(profile, track);
    if (!p) continue;
    const r = read(track, [p]);
    if (r.ok) out.push({ track, text: r.text });
  }
  return out;
}
