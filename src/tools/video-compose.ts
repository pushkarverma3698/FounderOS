/**
 * FounderOS — Video Factory: Compositing Compiler
 * ================================================
 * PURE function: (shot list, asset paths) → exact ffmpeg argv plans.
 * The compositor the audit found missing entirely (F9): transition chain
 * (xfade/concat), VO + ducked-music mix, caption burn-in, end fade, and the
 * 1:1 center-crop path (F11) — all compiled to data at plan time and executed
 * by the dumb runner. No shell strings: argv arrays only, so there is no
 * quoting ambiguity between compiler and executor.
 *
 * Timeline math contract: each non-final shot is trimmed to
 * duration_s + transition_out.duration_s; xfade consumes exactly the overlap,
 * so the final render duration equals the shot list's duration_s. Verified by
 * unit tests, enforced at runtime by the final QA probe step.
 */

import type { ShotList, Shot } from "./video-shotlist.js";

export interface FfmpegStep {
  id: string;
  argv: string[];
  produces: string;
}

export interface ComposePaths {
  /** shot_id → source asset path (Veo download or HyperFrames render). */
  shotFiles: Record<string, string>;
  /** Normalized intermediates directory. */
  workDir: string;
  voFile: string | null;
  musicFile: string | null;
  outFile: string;
}

const XFADE_NAMES: Record<string, string> = {
  fade: "fade",
  dissolve: "dissolve",
  slideleft: "slideleft",
  circleopen: "circleopen",
  wipeleft: "wipeleft",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Trimmed length of a shot's normalized clip (overlap for its outgoing xfade). */
export function trimmedLength(shot: Shot, isLast: boolean): number {
  return round2(shot.duration_s + (isLast ? 0 : shot.transition_out.duration_s));
}

/** Sanitize + escape text for a drawtext filter value (argv context, no shell). */
export function escDrawtext(text: string): string {
  const safe = text.replace(/[^\w\s.,:!?'’&@+·—-]/g, "");
  return safe.replace(/[\\':,;[\]=]/g, (m) => `\\${m}`);
}

/** Word-wrap a caption to fit the canvas — long brand copy must never clip. */
export function wrapCaption(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line !== "" && line.length + 1 + word.length > maxChars) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * Per-shot normalization: constant fps/SAR, cover-scale + center-crop to the
 * canvas (this is the whole 1:1 implementation — 16:9 sources crop to square
 * here), exact trim, audio stripped (VO/music own the mix).
 */
export function normalizeSteps(shotlist: ShotList, paths: ComposePaths): FfmpegStep[] {
  const { width: w, height: h } = shotlist.canvas;
  return shotlist.shots.map((shot, i) => {
    const isLast = i === shotlist.shots.length - 1;
    const out = `${paths.workDir}/${shot.id}.norm.mp4`;
    return {
      id: `norm-${shot.id}`,
      argv: [
        "-y",
        "-i", paths.shotFiles[shot.id] ?? `assets/${shot.id}.mp4`,
        "-vf", `fps=${shotlist.fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`,
        "-t", String(trimmedLength(shot, isLast)),
        "-an",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        out,
      ],
      produces: out,
    };
  });
}

function videoChain(shots: Shot[]): { filters: string[]; lastLabel: string } {
  const filters: string[] = [];
  let label = "[0:v]";
  let acc = trimmedLength(shots[0]!, shots.length === 1);
  for (let i = 1; i < shots.length; i++) {
    const prev = shots[i - 1]!;
    const cur = shots[i]!;
    const len = trimmedLength(cur, i === shots.length - 1);
    const next = `[vx${i}]`;
    const t = prev.transition_out;
    if (t.type === "cut" || t.duration_s === 0) {
      filters.push(`${label}[${i}:v]concat=n=2:v=1:a=0${next}`);
      acc = round2(acc + len);
    } else {
      const offset = round2(acc - t.duration_s);
      filters.push(`${label}[${i}:v]xfade=transition=${XFADE_NAMES[t.type] ?? "fade"}:duration=${t.duration_s}:offset=${offset}${next}`);
      acc = round2(acc + len - t.duration_s);
    }
    label = next;
  }
  return { filters, lastLabel: label };
}

function captionFilters(shotlist: ShotList): string {
  const { width: w, height: h } = shotlist.canvas;
  const size = Math.round(Math.min(w, h) * 0.052);
  // ~0.55em average glyph width in DejaVu Sans at these weights; 86% safe width.
  const maxChars = Math.max(12, Math.floor((w * 0.86) / (size * 0.55)));
  const lineGap = Math.round(size * 1.3);
  const overlays = shotlist.shots.filter((s) => s.overlay_text !== "");
  const filters: string[] = [];
  for (const s of overlays) {
    const start = round2(s.start_s + 0.3);
    const end = round2(s.start_s + s.duration_s - 0.15);
    const lines = wrapCaption(s.overlay_text, maxChars);
    // Anchor the block so its LAST line sits at 78% height regardless of line count.
    const blockTop = Math.round(h * 0.78) - (lines.length - 1) * lineGap;
    lines.forEach((line, i) => {
      filters.push(
        `drawtext=font=DejaVu Sans:text=${escDrawtext(line)}` +
          `:fontsize=${size}:fontcolor=white:borderw=${Math.max(2, Math.round(size * 0.07))}:bordercolor=black@0.55` +
          `:x=(w-text_w)/2:y=${blockTop + i * lineGap}:enable=between(t\\,${start}\\,${end})`,
      );
    });
  }
  return filters.join(",");
}

/**
 * The final composite: normalized clips in shot order + optional VO/music →
 * one delivered MP4. VO is trimmed/padded to the video duration (the video
 * timeline is the authority — the VO-fits check is a separate probe step that
 * fails loud instead of guessing, per audit F10).
 */
export function compositeStep(shotlist: ShotList, paths: ComposePaths): FfmpegStep {
  const shots = shotlist.shots;
  const T = shotlist.duration_s;
  const argv: string[] = ["-y"];
  for (const shot of shots) argv.push("-i", `${paths.workDir}/${shot.id}.norm.mp4`);
  const voIdx = paths.voFile ? shots.length : -1;
  const musicIdx = paths.musicFile ? shots.length + (paths.voFile ? 1 : 0) : -1;
  if (paths.voFile) argv.push("-i", paths.voFile);
  if (paths.musicFile) argv.push("-i", paths.musicFile);

  const { filters, lastLabel } = videoChain(shots);
  const captions = captionFilters(shotlist);
  const endFade = `fade=t=out:st=${round2(T - 0.6)}:d=0.6`;
  const vOps = [captions, endFade].filter((f) => f !== "").join(",");
  filters.push(`${lastLabel}${vOps}[vfinal]`);

  const audioFilters: string[] = [];
  if (voIdx >= 0) audioFilters.push(`[${voIdx}:a]atrim=0:${T},apad=whole_dur=${T}[vo]`);
  if (musicIdx >= 0) {
    audioFilters.push(
      `[${musicIdx}:a]atrim=0:${T},volume=${voIdx >= 0 ? "0.22" : "0.9"},afade=t=in:st=0:d=1.5,afade=t=out:st=${round2(T - 2.5)}:d=2.5,apad=whole_dur=${T}[mus]`,
    );
  }
  let audioLabel = "";
  if (voIdx >= 0 && musicIdx >= 0) {
    audioFilters.push(`[vo][mus]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[afinal]`);
    audioLabel = "[afinal]";
  } else if (voIdx >= 0 || musicIdx >= 0) {
    audioFilters.push(`${voIdx >= 0 ? "[vo]" : "[mus]"}loudnorm=I=-14:TP=-1.5:LRA=11[afinal]`);
    audioLabel = "[afinal]";
  }

  argv.push("-filter_complex", [...filters, ...audioFilters].join(";"));
  argv.push("-map", "[vfinal]");
  if (audioLabel) argv.push("-map", audioLabel, "-c:a", "aac", "-b:a", "192k");
  else argv.push("-an");
  argv.push("-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(shotlist.fps), "-t", String(T), "-movflags", "+faststart", paths.outFile);
  return { id: "composite", argv, produces: paths.outFile };
}

/** Full compositing plan: normalize each clip, then the final assembly. */
export function compileCompositePlan(shotlist: ShotList, paths: ComposePaths): FfmpegStep[] {
  return [...normalizeSteps(shotlist, paths), compositeStep(shotlist, paths)];
}
