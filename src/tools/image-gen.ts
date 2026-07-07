/**
 * FounderOS — Image Generation (Nano Banana)
 * ===========================================
 * Core image-generation primitive for the Creative department. Two tiers, with
 * the SAME cost discipline as the Ollama/Claude router (rule #17, ADR cost gate):
 *
 *   • DRAFT  → Nano Banana  (gemini-2.5-flash-image)  — cheap, the default.
 *   • FINAL  → Nano Banana Pro (gemini-3-pro-image)   — ~$0.134/img, gated on
 *              an EXPLICIT "final asset" intent AND a budget check by the caller.
 *
 * 2026-07-04: DRAFT's id was "gemini-3-1-flash-image" — nonexistent on the
 * Generative Language API (HTTP 404 on every real call, confirmed in prod
 * journalctl). Every unit test mocked fetch, so this shipped and stayed broken
 * in prod for days undetected. Fixed to "gemini-2.5-flash-image" — live-verified
 * against the real API (HTTP 200, real inline image bytes returned) before this
 * fix landed. FINAL's id was already correct (also live-verified).
 *
 * Model selection is a PURE function (rule #16: routing lives in deterministic
 * code, not a prompt the model may ignore). The HTTP call takes an injectable
 * `fetchImpl` so the whole path is unit-testable with $0 — no live paid call in
 * dev (cost gate #23). Provider: Google Generative Language `:generateContent`,
 * which returns the image as inline base64 in a candidate part.
 */

import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "image-gen" });

// ── Model registry ──────────────────────────────────────────────────────────

export type ImageTier = "draft" | "final";

export interface ImageModelSpec {
  /** Generative Language model id. */
  id: string;
  /** Approximate USD cost per generated image (pricing June 2026). */
  usdPerImage: number;
  tier: ImageTier;
}

/**
 * Nano Banana (Gemini 2.5 Flash Image) — fast drafts, the default.
 * `gemini-2.5-flash-image` is the id LIVE-VERIFIED against the real API
 * (2026-07-04, real inline image bytes returned — see file header). Cost
 * updated to ~$0.039/img at ≤1024px (1290 output tokens × $30/1M) — the prior
 * $0.01 figure was a rough guess. NOTE: Google has scheduled this model for
 * shutdown on 2026-10-02; the successor is `gemini-3.1-flash-image-preview`
 * ("Nano Banana 2", ~$0.067/img @1K) — set IMAGE_DRAFT_MODEL to swap when that
 * successor has been live-verified the same way.
 */
export const IMAGE_MODEL_DRAFT: ImageModelSpec = {
  id: process.env["IMAGE_DRAFT_MODEL"]?.trim() || "gemini-2.5-flash-image",
  usdPerImage: 0.039,
  tier: "draft",
};

/**
 * Nano Banana Pro (Gemini 3 Pro Image) — final, publish-grade assets. Gated.
 * `gemini-3-pro-image` (no `-preview` suffix) is the id LIVE-VERIFIED against
 * the real API (2026-07-04). A `gemini-3-pro-image-preview` alias was proposed
 * once but never live-verified — do not switch to it without re-verifying the
 * same way (real HTTP 200 + real image bytes), since an unverified id repeats
 * the exact DRAFT-model incident this file's header documents. Override with
 * IMAGE_FINAL_MODEL if a verified successor lands. ~$0.134/img at 1K–2K
 * (1120 tokens), ~$0.24 at 4K.
 */
export const IMAGE_MODEL_FINAL: ImageModelSpec = {
  id: process.env["IMAGE_FINAL_MODEL"]?.trim() || "gemini-3-pro-image",
  usdPerImage: 0.134,
  tier: "final",
};

/**
 * Choose the image model. Pure + deterministic.
 *
 * Pro is selected ONLY when the caller explicitly asks for a final/publish asset
 * (`final === true`). Ambiguity always resolves to the cheap draft model — the
 * expensive tier never fires by accident (same fail-cheap default as the LLM
 * router). The intent string is a secondary signal: it must contain an explicit
 * finalize word AND `final` must not be explicitly false.
 */
export function selectImageModel(opts: { final?: boolean; intent?: string }): ImageModelSpec {
  const intent = (opts.intent ?? "").toLowerCase();
  const intentSaysFinal = /\b(final asset|final version|publish-ready|production asset|hi-?res final)\b/.test(intent);
  const wantFinal = opts.final === true || (opts.final !== false && intentSaysFinal);
  return wantFinal ? IMAGE_MODEL_FINAL : IMAGE_MODEL_DRAFT;
}

// ── Generation ────────────────────────────────────────────────────────────────

export interface GeneratedImage {
  /** Base64-encoded image bytes (no data: prefix). */
  base64: string;
  mimeType: string;
  model: string;
  tier: ImageTier;
  usd: number;
}

export class ImageGenError extends Error {
  constructor(message: string, readonly stage: "config" | "request" | "parse") {
    super(message);
    this.name = "ImageGenError";
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

export interface GenerateImageDeps {
  fetchImpl?: FetchLike;
  apiKey?: string;
}

/**
 * Generate one image. Throws ImageGenError stage-tagged (rule #22: errors name
 * the real failing component — config vs network vs malformed response).
 */
export async function generateImage(
  prompt: string,
  opts: { final?: boolean; intent?: string } = {},
  deps: GenerateImageDeps = {},
): Promise<GeneratedImage> {
  const spec = selectImageModel(opts);
  const apiKey = deps.apiKey ?? process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  if (!apiKey) {
    throw new ImageGenError(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set — cannot generate images.",
      "config",
    );
  }
  const fetchImpl = (deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:generateContent?key=${apiKey}`;

  log.info({ model: spec.id, tier: spec.tier, usd: spec.usdPerImage }, "image-gen.request");

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
    });
  } catch (err) {
    throw new ImageGenError(`image API request failed: ${(err as Error).message}`, "request");
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new ImageGenError(`image API returned HTTP ${res.status}: ${raw.slice(0, 300)}`, "request");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ImageGenError(`image API returned non-JSON: ${raw.slice(0, 200)}`, "parse");
  }

  const inline = extractInlineImage(parsed);
  if (!inline) {
    throw new ImageGenError(
      `image API response had no inline image data: ${raw.slice(0, 200)}`,
      "parse",
    );
  }

  return {
    base64: inline.data,
    mimeType: inline.mimeType || "image/png",
    model: spec.id,
    tier: spec.tier,
    usd: spec.usdPerImage,
  };
}

/** Pull the first inlineData image part out of a generateContent response. Pure. */
export function extractInlineImage(
  resp: unknown,
): { data: string; mimeType: string } | null {
  const candidates = (resp as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidates)) return null;
  for (const c of candidates) {
    const parts = (c as { content?: { parts?: unknown[] } })?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      const inline = (p as { inlineData?: { data?: string; mimeType?: string } })?.inlineData
        ?? (p as { inline_data?: { data?: string; mime_type?: string } })?.inline_data;
      if (inline && typeof (inline as { data?: string }).data === "string") {
        const data = (inline as { data: string }).data;
        const mimeType =
          (inline as { mimeType?: string }).mimeType ??
          (inline as { mime_type?: string }).mime_type ??
          "image/png";
        return { data, mimeType };
      }
    }
  }
  return null;
}
