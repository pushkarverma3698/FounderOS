/**
 * FounderOS — UI vision verdict (the opt-in, paid half of the QA gate)
 * =====================================================================
 * A screenshot plus the page's own claimed purpose → a typed verdict about what
 * a human would see. This is the ONLY part of the UI gate that costs money, and
 * it is never reached unless a caller asks for it: ui-check's measurements are
 * free and catch most real breakage on their own.
 *
 * ## What vision is for, and what it is NOT for
 *
 * Measurement already answers "did the stylesheet load", "is there a placeholder
 * left", "does it scroll sideways". Vision answers only what measurement cannot:
 * is the hero text sitting on top of the image, is the CTA invisible against its
 * background, does this look like a finished page or a scaffold someone forgot
 * to fill in. Asking it to re-check what ui-check already measured would be
 * paying a model to repeat a free, deterministic answer.
 *
 * ## Anti-hallucination
 *
 * Copied from src/tools/vision.ts, which learned it the hard way: the model is
 * told to return `readable: false` when the screenshot is blank or unreadable,
 * so "I cannot see anything" is a first-class answer rather than an invented
 * list of defects. A parse failure is a failure, never an empty pass.
 */

import { geminiGenerate } from "../gemini-rest.js";
import { childLogger } from "../../infra/logger.js";
import type { UiSeverity } from "./ui-analyze.js";

const log = childLogger({ module: "tool:ui-vision" });

const VISION_MODEL = process.env["VISION_MODEL"] ?? "gemini-flash-latest";

/**
 * Hard ceiling on images per process, enforced by the caller through
 * `visionBudgetRemaining`. CLAUDE.md's zero-paid-calls rule makes an unbounded
 * image loop a bug, not a tuning question: 4 presets x 2 viewports is the
 * designed run, and anything past that is a mistake rather than a bigger job.
 */
export const MAX_VISION_IMAGES = 8;

export interface UiVisionDefect {
  readonly severity: UiSeverity;
  /** Where on the page, in plain words: "hero", "nav", "pricing table". */
  readonly area: string;
  /** What a visitor would see wrong, legible without reading any code. */
  readonly description: string;
}

export interface UiVerdict {
  readonly target: string;
  readonly viewport: string;
  /** false when the screenshot is blank/unreadable — never treated as a pass. */
  readonly readable: boolean;
  readonly ok: boolean;
  readonly defects: readonly UiVisionDefect[];
  /** One sentence a non-coder can act on. */
  readonly summary: string;
}

const PROMPT = `You are a meticulous web QA reviewer looking at a screenshot of a page that is about to be sent to a paying client.

Report ONLY defects that are visible in the image and that a visitor would notice:
- text overlapping other text or images, or running outside its container
- text that is unreadable against its background (contrast)
- a broken or obviously misaligned layout
- an element that is clearly a leftover scaffold or filler rather than finished content
- an empty region where content plainly should be

Do NOT report:
- anything you would need the HTML or CSS to know
- subjective taste, colour preference, or suggestions to improve the design
- missing images or stylesheets (these are measured separately and reliably)

Rules:
- If the screenshot is blank, all one colour, or otherwise unreadable, set readable=false, ok=false, defects=[] and say so in summary. NEVER invent defects you cannot see.
- If the page looks correct, set ok=true and defects=[]. A clean page is a valid and expected answer.
- severity: "high" only if a client seeing this would consider the page broken; "medium" for a visible flaw; "low" for a minor blemish.
- summary must be one sentence, understandable by someone who has never seen the code.

Respond ONLY with JSON:
{"readable": boolean, "ok": boolean, "summary": string, "defects": [{"severity": "high"|"medium"|"low", "area": string, "description": string}]}`;

/** Parse + validate the model's JSON. Exported for unit tests. Never throws. */
export function parseVisionVerdict(raw: string): Omit<UiVerdict, "target" | "viewport"> | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (typeof obj["readable"] !== "boolean" || typeof obj["ok"] !== "boolean") return null;

    const rawDefects = Array.isArray(obj["defects"]) ? obj["defects"] : [];
    const defects: UiVisionDefect[] = rawDefects.flatMap((d) => {
      if (typeof d !== "object" || d === null) return [];
      const rec = d as Record<string, unknown>;
      const severity = rec["severity"];
      if (severity !== "high" && severity !== "medium" && severity !== "low") return [];
      return [{
        severity,
        area: typeof rec["area"] === "string" ? rec["area"] : "page",
        description: typeof rec["description"] === "string" ? rec["description"] : "",
      }];
    });

    // An unreadable screenshot can never be a pass — that is the whole point of
    // the flag. Recompute rather than trusting the model to keep them consistent.
    const readable = obj["readable"];
    return {
      readable,
      ok: readable ? obj["ok"] === true && defects.every((d) => d.severity !== "high") : false,
      summary: typeof obj["summary"] === "string" ? obj["summary"] : "",
      defects,
    };
  } catch {
    return null;
  }
}

export type UiVisionResult =
  | { success: true; verdict: UiVerdict }
  | { success: false; error: string };

/**
 * Ask the vision model what a visitor would see wrong.
 *
 * Never throws. A transport failure, an unparseable response, or a missing API
 * key all return `success: false` with a reason the report prints verbatim —
 * a stage that did not run must never render as a stage that came back clean.
 */
export async function judgeScreenshot(
  png: Buffer,
  meta: { target: string; viewport: string; purpose?: string },
): Promise<UiVisionResult> {
  if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
    return { success: false, error: "GOOGLE_GENERATIVE_AI_API_KEY is not set — vision stage cannot run" };
  }

  const context = meta.purpose
    ? `\n\nThis page is meant to be: ${meta.purpose}`
    : "";

  try {
    const res = await geminiGenerate({
      model: VISION_MODEL,
      responseMimeType: "application/json",
      parts: [
        { text: PROMPT + context },
        { inlineData: { mimeType: "image/png", data: png.toString("base64") } },
      ],
    });

    const parsed = parseVisionVerdict(res.text);
    if (!parsed) {
      log.error({ raw: res.text.slice(0, 300) }, "Vision verdict was not valid JSON");
      return { success: false, error: "Vision model returned an unparseable response" };
    }

    log.info(
      { target: meta.target, viewport: meta.viewport, ok: parsed.ok, defects: parsed.defects.length },
      "UI vision verdict",
    );
    return { success: true, verdict: { ...parsed, target: meta.target, viewport: meta.viewport } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ target: meta.target, err: msg }, "UI vision call failed");
    return { success: false, error: msg };
  }
}
