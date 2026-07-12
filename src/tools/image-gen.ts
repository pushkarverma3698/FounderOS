/**
 * FounderOS — Image Generation (Nano Banana)
 * ===========================================
 * Core image-generation primitive for the Creative department. Two tiers, with
 * the SAME cost discipline as the Ollama/Claude router (rule #17, ADR cost gate):
 *
 *   • DRAFT  → Nano Banana 2  (gemini-3.1-flash-image)  — cheap, the default.
 *   • FINAL  → Nano Banana Pro (gemini-3-pro-image)     — ~$0.134/img, gated on
 *              an EXPLICIT "final asset" intent AND a budget check by the caller.
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

/** Nano Banana 2 — fast drafts. The default for everything but explicit finals. */
export const IMAGE_MODEL_DRAFT: ImageModelSpec = {
  // Dot, not dash: "gemini-3-1-flash-image" 404'd live on 2026-07-12; the id
  // on the Generative Language API is "gemini-3.1-flash-image" (ListModels).
  id: "gemini-3.1-flash-image",
  usdPerImage: 0.01,
  tier: "draft",
};

/** Nano Banana Pro — final, publish-grade assets. Gated. */
export const IMAGE_MODEL_FINAL: ImageModelSpec = {
  id: "gemini-3-pro-image",
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
  /** Hard ceiling for the generateContent call. A stalled call must fail fast
   *  (loud, stage-tagged) instead of riding to the 180s turn timeout as silence
   *  (#19.5/#22.3). Default from IMAGE_GEN_TIMEOUT_MS or 60s. */
  timeoutMs?: number;
}

/** Default hard ceiling for a single image API call (ms). Below the 180s turn
 *  timeout so the founder gets a real error, never silence. */
const DEFAULT_IMAGE_TIMEOUT_MS = 60_000;

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
  const timeoutMs =
    deps.timeoutMs ??
    (Number(process.env["IMAGE_GEN_TIMEOUT_MS"]) || DEFAULT_IMAGE_TIMEOUT_MS);
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${spec.id}:generateContent?key=${apiKey}`;

  log.info({ model: spec.id, tier: spec.tier, usd: spec.usdPerImage, timeoutMs }, "image-gen.request");

  let res: Awaited<ReturnType<FetchLike>>;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    res = await Promise.race([
      fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ImageGenError(`image API did not respond within ${timeoutMs}ms`, "request")),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (err instanceof ImageGenError) throw err;
    throw new ImageGenError(`image API request failed: ${(err as Error).message}`, "request");
  } finally {
    if (timer) clearTimeout(timer);
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
