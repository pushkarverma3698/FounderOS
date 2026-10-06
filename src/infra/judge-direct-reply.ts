/**
 * The judge's rule for a direct reply: an answer the planner gave without running any step.
 *
 * Before, only answers that came out of the step pipeline were judged. A direct reply is where an invented
 * "nothing is running" or "I sent it" lives, because the model can say anything with no step to contradict it.
 * With no step there is no ground truth, so a claim about the system is exactly the defect groundedness exists
 * to catch, and the judge is told so instead of being left to guess.
 *
 * Judge health: a direct reply is judged on top of the planned turns that were judged before. Its failures
 * are logged and stored as not_evaluated like any other, but they never feed the outage counter
 * (infra/judge-health.ts): a free-tier rate limit hitting the extra volume must not raise the judge-down
 * alert more often than the planned-turn volume alone did. A real outage still trips the counter through
 * the planned turns and judgeOutbound.
 */

export const NO_STEPS_NOTE = [
  "STEP RESULTS: none were produced. No step was run for this answer, so it is a direct reply.",
  "Any claim about system state, tools, past actions or data (what ran, what was sent, what is idle,",
  "what a record contains) has no supporting step and is ungrounded: score groundedness low in",
  "proportion to how much of the answer rests on such claims. Plain conversation, general knowledge",
  "and asking the founder for missing information need no step and are not ungrounded.",
].join("\n");

/** True when the answer came with no step results: it is judged, but its failures stay out of the health counter. */
export function isDirectReply(input: { readonly steps: readonly unknown[] }): boolean {
  return input.steps.length === 0;
}
