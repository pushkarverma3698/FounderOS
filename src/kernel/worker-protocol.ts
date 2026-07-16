/**
 * FounderOS v3 kernel — worker prompt protocol (pure builders).
 * ==============================================================
 * The deterministic instruction strings the agent node composes around a
 * TaskEnvelope. Split out of worker.ts for the 400-LOC budget; no logic —
 * every function here is a pure string builder keyed off the envelope.
 */

import { HumanMessage } from "@langchain/core/messages";
import { getSchemaTemplate, type TaskEnvelope } from "./contracts.js";

/** Terminal-turn nudge (transient; never stored) forcing a JSON finalize from the tool results already gathered. */
export function finalizeNudge(step: TaskEnvelope): HumanMessage {
  return new HumanMessage(
    `You have no tool calls left for this step. Do NOT call any tool. ` +
      `Reply NOW with ONE JSON object satisfying "${step.expected.schema_ref}", built ONLY from the tool ` +
      `results above. If they are insufficient, say so honestly inside the JSON — never return an empty message.`,
  );
}

/** The EXECUTION PROTOCOL block appended to every worker system prompt. */
export function workerProtocol(step: TaskEnvelope, remainingCalls: number): string {
  const template = getSchemaTemplate(step.expected.schema_ref);
  return [
    ``,
    `EXECUTION PROTOCOL:`,
    `- You are completing ONE step: "${step.objective}"`,
    `- Tool calls remaining for this step: ${remainingCalls}. When it reaches 0 you MUST finalize.`,
    `- Finalize by replying with ONE JSON object satisfying schema "${step.expected.schema_ref}".`,
    `- Do NOT wrap your output in a outer key named "${step.expected.schema_ref}" or any other root wrapper. Output the fields directly at the root.`,
    `- Your JSON must match this structure:`,
    template,
    `- Report failures honestly; never fabricate tool output. Rejected approvals are final.`,
  ].join("\n");
}
