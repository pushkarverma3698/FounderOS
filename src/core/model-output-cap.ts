/**
 * FounderOS — model output cap (MODEL_MAX_OUTPUT_TOKENS)
 * ======================================================
 * The ONE reading of the output cap every chat model is built with: the model
 * factory (src/agents/model.ts) and the judge (src/infra/judge-model.ts).
 *
 * WHY. Until 2026-10-08 no constructor set an output limit, so OpenRouter
 * reserved the model's full output window (65,536 tokens on Sonnet 5.5)
 * against the balance on every call, and a 402 arrived with credit still on the
 * key (AG-050). A reply, a plan or a tool call fits well inside 4096.
 *
 * Reads process.env at call time rather than importing core/config.ts, for the
 * same reason as core/gemini-thinking.ts: config.ts validates the whole
 * environment on import, and scripts load the model factory without it.
 */

export const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 4096;

export function modelMaxOutputTokens(): number {
  const n = Number(process.env["MODEL_MAX_OUTPUT_TOKENS"]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MODEL_MAX_OUTPUT_TOKENS;
}
