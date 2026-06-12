/**
 * FounderOS — Text-to-Speech Tool
 * ================================
 * English text → spoken voice note. Gemini 2.5 Flash TTS returns raw PCM
 * (s16le, 24kHz, mono); we convert to OGG/Opus via ffmpeg for Telegram
 * sendVoice.
 *
 * Fail-open: any error returns { success: false } — the gateway then sends
 * text-only instead of a voice note. Never crashes the bot.
 */

import { geminiGenerate } from "./gemini-rest.js";
import { checkFfmpeg, pcmToOggOpus } from "../infra/media-convert.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:tts" });

const TTS_MODEL = process.env["TTS_MODEL"] ?? "gemini-2.5-flash-preview-tts";
const TTS_VOICE = process.env["TTS_VOICE"] ?? "Kore";
const TTS_MAX_CHARS = 4_000;

export type TtsResult =
  | { success: true; data: { oggOpus: Buffer } }
  | { success: false; error: string };

/** Extract the PCM sample rate from a Gemini audio MIME like "audio/L16;codec=pcm;rate=24000". */
export function parsePcmRate(mimeType: string, fallback = 24_000): number {
  const m = mimeType.match(/rate=(\d+)/);
  const rate = m?.[1] ? Number.parseInt(m[1], 10) : NaN;
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

/** Synthesize English text into an OGG/Opus voice note buffer. */
export async function synthesizeSpeech(text: string): Promise<TtsResult> {
  if (!text.trim()) return { success: false, error: "Nothing to speak — empty text" };
  if (!(await checkFfmpeg())) {
    return { success: false, error: "ffmpeg not available — voice output disabled" };
  }
  try {
    const res = await geminiGenerate({
      model: TTS_MODEL,
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
      // temperature MUST be omitted: temp 0 stalls the TTS model (live-measured).
      temperature: null,
      // "Say: " is consumed as a style directive, not spoken. Without it short
      // conversational text returns 400 "Model tried to generate text".
      parts: [{ text: `Say: ${text.slice(0, TTS_MAX_CHARS)}` }],
    });
    if (!res.inlineData) {
      return { success: false, error: "TTS model returned no audio data" };
    }
    const pcm = Buffer.from(res.inlineData.data, "base64");
    const rate = parsePcmRate(res.inlineData.mimeType);
    const oggOpus = await pcmToOggOpus(pcm, rate);
    log.info({ chars: text.length, pcmBytes: pcm.length, oggBytes: oggOpus.length, rate }, "TTS synthesized");
    return { success: true, data: { oggOpus } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "TTS synthesis failed");
    return { success: false, error: msg };
  }
}
