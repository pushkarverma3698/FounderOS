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

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** Map a Gemini model id to its OpenRouter slug. An id that already has a "vendor/" prefix passes through. */
export function openRouterModel(model: string): string {
  if (model.includes("/")) return model;
  if (/^gemini-flash-latest$|^gemini-2\.5-flash$/.test(model)) return "google/gemini-2.5-flash";
  return `google/${model}`;
}

/** Translate Gemini parts into OpenRouter chat content (text, image_url, input_audio). */
export function toOpenRouterContent(parts: GeminiPart[]): Array<Record<string, unknown>> {
  return parts.map((p) => {
    if (p.text !== undefined) return { type: "text", text: p.text };
    const mime = p.inlineData!.mimeType;
    const data = p.inlineData!.data;
    if (mime.startsWith("audio/")) {
      const format = /mp3|mpeg/.test(mime) ? "mp3" : /ogg/.test(mime) ? "ogg" : "wav";
      return { type: "input_audio", input_audio: { data, format } };
    }
    return { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } };
  });
}

/** Vision / audio-in / text through OpenRouter: the Google key is not needed, one billing pool. */
async function callOpenRouter(opts: GeminiGenerateOptions, key: string): Promise<GeminiInlineResult> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: openRouterModel(opts.model),
      temperature: opts.temperature ?? 0,
      ...(opts.responseMimeType === "application/json" ? { response_format: { type: "json_object" } } : {}),
      messages: [{ role: "user", content: toOpenRouterContent(opts.parts) }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => ""); // allow-failopen: error body is diagnostic text only
    throw new Error(`OpenRouter ${opts.model} HTTP ${res.status}: ${errBody.slice(0, 500)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const text = (json.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error(`OpenRouter ${opts.model} returned an empty reply`);
  return { text };
}

async function callOnce(opts: GeminiGenerateOptions): Promise<GeminiInlineResult> {
  // Audio-out (TTS) needs Gemini's AUDIO modality; everything else goes through OpenRouter when its key is set.
  const orKey = process.env["OPENROUTER_API_KEY"];
  if (orKey && !opts.responseModalities) return callOpenRouter(opts, orKey);
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
