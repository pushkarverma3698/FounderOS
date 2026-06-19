/**
 * FounderOS — Media Conversion (infra)
 * =====================================
 * Thin ffmpeg wrappers for the audio formats the gateway needs:
 *   - Telegram voice notes arrive as OGG/Opus → Gemini wants WAV/MP3 → oggToWav()
 *   - Gemini TTS returns raw PCM s16le 24kHz → Telegram sendVoice wants OGG/Opus → pcmToOggOpus()
 *
 * ffmpeg availability is probed once and cached (checkFfmpeg). Callers must
 * degrade gracefully (text-only) when ffmpeg is missing — never crash the bot.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { childLogger } from "./logger.js";

const execFileAsync = promisify(execFile);
const log = childLogger({ module: "media-convert" });

const FFMPEG_TIMEOUT_MS = 30_000;

let _ffmpegAvailable: boolean | null = null;

/** Probe ffmpeg once; cached for the process lifetime. */
export async function checkFfmpeg(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 });
    _ffmpegAvailable = true;
  } catch (err) {
    log.error({ err: (err as Error).message }, "ffmpeg not available — voice features degraded to text-only");
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

/** Test hook: reset the cached probe result. */
export function resetFfmpegCache(): void {
  _ffmpegAvailable = null;
}

/** Run ffmpeg over temp files: write input, convert, read output, always clean up. */
async function convertViaTemp(
  input: Buffer,
  inExt: string,
  outExt: string,
  args: (inPath: string, outPath: string) => string[],
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "founderos-media-"));
  const inPath = join(dir, `in.${inExt}`);
  const outPath = join(dir, `out.${outExt}`);
  try {
    await writeFile(inPath, input);
    await execFileAsync("ffmpeg", args(inPath, outPath), { timeout: FFMPEG_TIMEOUT_MS });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Browser-recorded audio (webm/ogg/mp4) → 16kHz mono WAV for Gemini transcription. */
export async function audioToWav(input: Buffer, inExt: string): Promise<Buffer> {
  const ext = inExt.replace(/^\./, "") || "webm";
  return convertViaTemp(input, ext, "wav", (i, o) => [
    "-y", "-i", i, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", o,
  ]);
}

/** Telegram voice note (OGG/Opus) → 16kHz mono WAV (Gemini-supported). */
export async function oggToWav(ogg: Buffer): Promise<Buffer> {
  return audioToWav(ogg, "ogg");
}

/** Gemini TTS raw PCM (s16le, mono) → OGG/Opus for Telegram sendVoice. */
export async function pcmToOggOpus(pcm: Buffer, sampleRate = 24_000): Promise<Buffer> {
  return convertViaTemp(pcm, "pcm", "ogg", (i, o) => [
    "-y", "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", i,
    "-c:a", "libopus", "-b:a", "32k", o,
  ]);
}
