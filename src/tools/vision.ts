/**
 * FounderOS — Vision Translation Tool
 * ====================================
 * Image bytes → { sourceLanguage, originalText, englishText } via Gemini Flash
 * vision. Used by the Telegram media gateway: founder photographs a Dutch
 * letter/sign/menu → bot replies with the English translation.
 *
 * Fail-open: any error returns { success: false } — never throws.
 * Anti-hallucination: the model is told to return hasText=false for images with
 * no readable text; the gateway then replies "couldn't find readable text"
 * instead of inventing a translation.
 */

import { geminiGenerate } from "./gemini-rest.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:vision" });

const VISION_MODEL = process.env["VISION_MODEL"] ?? "gemini-2.5-flash";

export interface ImageTranslation {
  /** Detected language of the text in the image, e.g. "Dutch". "English" if already English. */
  sourceLanguage: string;
  /** The text exactly as it appears in the image. */
  originalText: string;
  /** English translation (equals originalText when already English). */
  englishText: string;
  /** false when the image contains no readable text. */
  hasText: boolean;
}

export type VisionResult =
  | { success: true; data: ImageTranslation }
  | { success: false; error: string };

const PROMPT = `You are an exact OCR + translation engine. Look at the image and:
1. Extract ALL readable text exactly as written (preserve line breaks).
2. Detect the language of that text.
3. Translate it to natural English.

Rules:
- If the image contains NO readable text (photo of a scene, blur, abstract), set hasText=false and leave the text fields empty. NEVER invent text that is not in the image.
- If the text is already English, set sourceLanguage="English" and englishText = the original text verbatim — do not rewrite it.
- Respond ONLY with JSON: {"hasText": boolean, "sourceLanguage": string, "originalText": string, "englishText": string}`;

/** Parse + validate the model's JSON. Exported for unit tests. */
export function parseVisionResponse(raw: string): ImageTranslation | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const obj = JSON.parse(cleaned) as Partial<ImageTranslation>;
    if (typeof obj.hasText !== "boolean") return null;
    return {
      hasText: obj.hasText,
      sourceLanguage: typeof obj.sourceLanguage === "string" ? obj.sourceLanguage : "",
      originalText: typeof obj.originalText === "string" ? obj.originalText : "",
      englishText: typeof obj.englishText === "string" ? obj.englishText : "",
    };
  } catch {
    return null;
  }
}

/**
 * Extract + translate the text in an image to English.
 * @param imageBytes raw image bytes (largest Telegram photo size)
 * @param mimeType   e.g. "image/jpeg", "image/png"
 */
export async function translateImage(imageBytes: Buffer, mimeType: string): Promise<VisionResult> {
  try {
    const res = await geminiGenerate({
      model: VISION_MODEL,
      responseMimeType: "application/json",
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: imageBytes.toString("base64") } },
      ],
    });
    const parsed = parseVisionResponse(res.text);
    if (!parsed) {
      log.error({ raw: res.text.slice(0, 300) }, "Vision response was not valid JSON");
      return { success: false, error: "Vision model returned an unparseable response" };
    }
    log.info(
      { lang: parsed.sourceLanguage, hasText: parsed.hasText, chars: parsed.originalText.length },
      "Image translated",
    );
    return { success: true, data: parsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, "Image translation failed");
    return { success: false, error: msg };
  }
}
