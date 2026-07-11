/**
 * FounderOS — Audio Transcription Tool
 * =====================================
 * Audio bytes (WAV/MP3 — convert OGG first via infra/media-convert) →
 * { detectedLanguage, transcript, englishText } via Gemini Flash audio.
 *
 * STRICT ORDER (Feature B contract): transcribe → detect language → translate
 * to English. The gateway only injects englishText into the agent pipeline —
 * voice is just an input method, never a bypass.
 *
 * Anti-hallucination (DANGEROUS failure mode): silence/noise must yield
 * hasSpeech=false, never an invented command that could then execute.
 * Belt-and-braces: the prompt forbids it AND the code rejects empty/too-short
 * transcripts.
 */

import { geminiGenerate } from "./gemini-rest.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:transcription" });

const AUDIO_MODEL = process.env["TRANSCRIPTION_MODEL"] ?? "gemini-flash-latest";
const MIN_TRANSCRIPT_CHARS = 3;

export interface Transcription {
  /** e.g. "Dutch", "English" */
  detectedLanguage: string;
  /** Verbatim transcript in the spoken language. */
  transcript: string;
  /** English version (equals transcript when spoken language is English). */
  englishText: string;
  /** false when no intelligible speech was found. */
  hasSpeech: boolean;
}

export type TranscriptionResult =
  | { success: true; data: Transcription }
  | { success: false; error: string };

const PROMPT = `You are an exact speech transcription engine. Listen to the audio and:
1. Transcribe the speech verbatim in the language spoken.
2. Detect the spoken language.
3. Translate the transcript to natural English.

Rules:
- If the audio contains NO intelligible speech (silence, noise, music, mumble), set hasSpeech=false and leave the text fields empty. NEVER guess or invent words that were not clearly spoken — an invented command could trigger a real action.
- If the speech is English, set detectedLanguage="English" and englishText = the transcript verbatim.
- Respond ONLY with JSON: {"hasSpeech": boolean, "detectedLanguage": string, "transcript": string, "englishText": string}`;

/** Parse + validate the model's JSON, enforcing the no-hallucination floor. Exported for unit tests. */
export function parseTranscriptionResponse(raw: string): Transcription | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const obj = JSON.parse(cleaned) as Partial<Transcription>;
    if (typeof obj.hasSpeech !== "boolean") return null;
    const transcript = typeof obj.transcript === "string" ? obj.transcript.trim() : "";
    const englishText = typeof obj.englishText === "string" ? obj.englishText.trim() : "";
    // Code-level guard: a "speech" result with a near-empty transcript is noise.
    const hasSpeech = obj.hasSpeech && transcript.length >= MIN_TRANSCRIPT_CHARS && englishText.length >= MIN_TRANSCRIPT_CHARS;
    return {
      hasSpeech,
      detectedLanguage: typeof obj.detectedLanguage === "string" ? obj.detectedLanguage : "",
      transcript,
      englishText,
    };
  } catch {
    return null;
  }
}

/**
 * Transcribe audio, detect language, and translate to English.
 * @param audioBytes Gemini-supported audio (use oggToWav() for Telegram voice notes first)
 * @param mimeType   e.g. "audio/wav", "audio/mp3"
 */
export async function transcribeAudio(audioBytes: Buffer, mimeType = "audio/wav"): Promise<TranscriptionResult> {
  try {
    const res = await geminiGenerate({
      model: AUDIO_MODEL,
      responseMimeType: "application/json",
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: audioBytes.toString("base64") } },
      ],
    });
    const parsed = parseTranscriptionResponse(res.text);
    if (!parsed) {
      log.error({ raw: res.text.slice(0, 300) }, "Transcription response was not valid JSON");
      return { success: false, error: "Transcription model returned an unparseable response" };
    }
    log.info(
      { lang: parsed.detectedLanguage, hasSpeech: parsed.hasSpeech, chars: parsed.transcript.length },
      "Audio transcribed",
    );
    return { success: true, data: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "Audio transcription failed");
    return { success: false, error: msg };
  }
}
