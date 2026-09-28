/**
 * FounderOS — Gemini thinking level (GEMINI_THINKING_LEVEL)
 * =========================================================
 * The ONE parse of the thinking level every `ChatGoogleGenerativeAI` is built
 * with: the model factory (src/agents/model.ts), the kernel's judge
 * (src/infra/judge-model.ts) and the QA battery's content judge
 * (scripts/lib/content-judge.ts). Three constructors, one reading of the env.
 *
 * WHY LOW. Until 2026-09-28 no constructor set `thinkingConfig`, so Gemini 3.x
 * ran its default dynamic thinking on every call. Measured on the real planner
 * prompt (docs/plans/2026-09-28-perf-ux-rag-audit.md §1): 473-615 thought
 * tokens and 4.2-4.8 s per call, against 0 thought tokens and 1.6-1.7 s with a
 * low level, and the planner JSON stayed valid. A tool turn makes four or five
 * of these calls. The thoughts were also invisible to the cost ledger.
 *
 * DEFAULT omits `thinkingConfig` — Google's dynamic thinking, the behaviour
 * before this change. It is the rollback lever if plan quality drops, and
 * scripts/apply-prod-env-overrides.sh preserves an on-box value across deploys.
 *
 * Reads process.env at call time rather than importing core/config.ts: that
 * module validates the whole environment (DATABASE_URL, TELEGRAM_*) on import,
 * and the model factory and judge are loaded by scripts that have neither.
 *
 * A value outside the list THROWS. Boot builds the models (src/index.ts →
 * getKernel), so a typo stops the deploy with this message rather than quietly
 * running at a level nobody chose.
 */

import type { GoogleGenerativeAIChatInput } from "@langchain/google-genai";

/** `thinkingConfig` exactly as the installed @langchain/google-genai types it. */
export type GeminiThinkingConfig = NonNullable<GoogleGenerativeAIChatInput["thinkingConfig"]>;

/**
 * The levels this repo accepts. MINIMAL is a real API level, but the installed
 * library's type (`"THINKING_LEVEL_UNSPECIFIED" | "LOW" | "MEDIUM" | "HIGH"`)
 * does not include it, so it is refused rather than forced through a cast.
 */
export const GEMINI_THINKING_LEVELS = ["LOW", "MEDIUM", "HIGH", "DEFAULT"] as const;
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];

export const GEMINI_THINKING_ENV = "GEMINI_THINKING_LEVEL";

/** Unset or blank → LOW. Case-insensitive. Anything else throws, naming the choices. */
export function parseGeminiThinkingLevel(raw: string | undefined): GeminiThinkingLevel {
  const value = (raw ?? "").trim().toUpperCase();
  if (value === "") return "LOW";
  if ((GEMINI_THINKING_LEVELS as readonly string[]).includes(value)) return value as GeminiThinkingLevel;
  throw new Error(
    `${GEMINI_THINKING_ENV}="${raw}" is not one of ${GEMINI_THINKING_LEVELS.join(", ")} (unset means LOW).`,
  );
}

/**
 * The `thinkingConfig` to pass to `ChatGoogleGenerativeAI`, or undefined for
 * DEFAULT. Passing undefined is safe: the constructor then omits the field from
 * `generationConfig` (@langchain/google-genai 2.1.31, dist/chat_models.js:447,458).
 */
export function geminiThinkingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GeminiThinkingConfig | undefined {
  const level = parseGeminiThinkingLevel(env[GEMINI_THINKING_ENV]);
  return level === "DEFAULT" ? undefined : { thinkingLevel: level };
}
