/**
 * FounderOS — Gemini REST helper (multimodal)
 * ============================================
 * Direct generateContent REST calls for vision / audio / TTS — payloads the
 * LangChain chat adapter doesn't carry (inline media, AUDIO response modality).
 *
 * Inherits the SAME transient-error policy as the office model factory:
 * is503Error() + RETRY_BACKOFF_MS are imported from src/agents/model.ts so a
 * single Gemini 503/429/network blip never kills a vision/transcription/TTS
 * call (CLAUDE.md hardening rule — no naked API calls).
 */

import { is503Error, RETRY_BACKOFF_MS } from "../agents/model.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "gemini-rest" });

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const REQUEST_TIMEOUT_MS = 60_000;

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiGenerateOptions {
  model: string;
  parts: GeminiPart[];
  /** e.g. "application/json" to force structured output */
  responseMimeType?: string;
  /** e.g. ["AUDIO"] for TTS */
  responseModalities?: string[];
  /** TTS voice config */
  speechConfig?: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } };
  /**
   * Sampling temperature. Defaults to 0 (determinism rule #16). Pass null to
   * OMIT temperature entirely — REQUIRED for the TTS model: temperature:0
   * makes gemini-2.5-flash-preview-tts hang/return finishReason=OTHER with no
   * audio (measured live 2026-06-12: temp 0 → 45s+ stall, default → ~3s).
   */
  temperature?: number | null;
}

export interface GeminiInlineResult {
  /** Concatenated text parts (empty string if none). */
  text: string;
  /** First inline-data part (e.g. TTS audio), if any. */
  inlineData?: { mimeType: string; data: string };
}

function apiKey(): string {
  const key = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  if (!key) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY not set");
  return key;
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function callOnce(opts: GeminiGenerateOptions): Promise<GeminiInlineResult> {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      ...(opts.temperature === null ? {} : { temperature: opts.temperature ?? 0 }),
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      ...(opts.responseModalities ? { responseModalities: opts.responseModalities } : {}),
      ...(opts.speechConfig ? { speechConfig: opts.speechConfig } : {}),
    },
  };

  const res = await fetch(`${BASE_URL}/${opts.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini ${opts.model} HTTP ${res.status}: ${errBody.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> };
    }>;
  };

  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  const inlineData = parts.find((p) => p.inlineData)?.inlineData;
  if (!text && !inlineData) {
    throw new Error(`Gemini ${opts.model} returned an empty candidate (no text, no inline data)`);
  }
  return { text, ...(inlineData ? { inlineData } : {}) };
}

/**
 * generateContent with the office's standard retry/backoff policy.
 * Transient errors (503/429/500/network) retry with backoff; everything else
 * surfaces immediately to the caller, which converts to a friendly bot message.
 */
export async function geminiGenerate(opts: GeminiGenerateOptions): Promise<GeminiInlineResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BACKOFF_MS[attempt - 1]!;
      log.warn({ model: opts.model, attempt, delayMs: delay }, "Gemini media call transient error — retrying");
      await sleepMs(delay);
    }
    try {
      return await callOnce(opts);
    } catch (err) {
      // Fetch-timeout aborts (AbortSignal.timeout) are transient too — a single
      // slow Gemini response must not kill the call (observed live 2026-06-11:
      // one TTS request hung 60s while an identical retry completed in 3s).
      const isTimeout = err instanceof Error && /aborted due to timeout|TimeoutError/i.test(`${err.name}: ${err.message}`);
      if (!is503Error(err) && !isTimeout) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
