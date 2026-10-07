/**
 * Request options for ChatAnthropic that depend on the model generation (AG-031).
 *
 * buildModel() always passed `temperature` and left @langchain/anthropic's default
 * `thinking: { type: "disabled" }` in place. Anthropic's API returns a 400 for both
 * on the newer generations: they accept only adaptive thinking and reject any
 * non-default sampling parameter. @langchain/anthropic 1.4.1 knows this for Opus 4.7
 * and later, Fable 5 and Mythos, and it refuses temperature + thinking together
 * (utils/params.ts), so the model is built with adaptive thinking and no temperature.
 * Sonnet 5 and Opus 5 are not in the library's list yet, hence the list here.
 *
 * Older Claude models keep exactly what they got before: temperature, no thinking.
 *
 * Pure: no env, no model construction. Tested without a key.
 */

/** Model-name prefixes that accept only adaptive thinking and no sampling parameters. */
const ADAPTIVE_ONLY_PREFIXES = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-mythos",
] as const;

export type AnthropicModelOptions =
  | { readonly temperature: number }
  | { readonly thinking: { readonly type: "adaptive" } };

/** Constructor options to spread into `new ChatAnthropic({ ... })` for `model`. */
export function anthropicModelOptions(model: string, temperature: number): AnthropicModelOptions {
  const adaptiveOnly = ADAPTIVE_ONLY_PREFIXES.some((prefix) => model.startsWith(prefix));
  return adaptiveOnly ? { thinking: { type: "adaptive" } } : { temperature };
}
