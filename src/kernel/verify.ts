/**
 * FounderOS v3 kernel — verification node.
 * ==========================================
 * Pure code node to verify worker outputs against semantic or functional requirements
 * before they are committed to the results channel.
 */

import type { StepResult, TaskEnvelope } from "./contracts.js";

export interface StepVerifier {
  verify(output: unknown, envelope: TaskEnvelope): Promise<{ ok: boolean; error?: string }>;
}

export const VERIFIERS: Record<string, StepVerifier> = {
  /** comms verifier: check that email and other communication drafts do not leak raw placeholders or templates */
  "comms": {
    async verify(output, envelope) {
      const text = typeof output === "object" && output !== null
        ? JSON.stringify(output)
        : String(output);
      
      // Look for unrendered mustache-like or brace placeholders: {{name}}, [Recipient], etc.
      if (/\{\{[\w\s_-]+\}\}/.test(text) || /\[\s*[A-Z][a-z]+(\s+[A-Z][a-z]+)*\s*\]/.test(text)) {
        return { ok: false, error: "Output draft contains unresolved template placeholders." };
      }
      return { ok: true };
    }
  }
};

/** Run verification on a step result. Returns the original result if valid, or a failed result if validation checks fail. */
export async function verifyStepResult(result: StepResult, envelope: TaskEnvelope): Promise<StepResult> {
  if (result.status === "failed") return result;

  const verifier = VERIFIERS[envelope.worker];
  if (!verifier) return result;

  try {
    const check = await verifier.verify(result.output, envelope);
    if (!check.ok) {
      return {
        status: "failed",
        step_id: result.step_id,
        failure: {
          step_id: result.step_id,
          stage: "validation",
          component: `kernel/verify:${envelope.worker}`,
          message: check.error ?? "Functional verification failed.",
          evidence: typeof result.output === "string" ? result.output.slice(0, 300) : JSON.stringify(result.output).slice(0, 300),
          retryable: true,
        }
      };
    }
  } catch (err) {
    return {
      status: "failed",
      step_id: result.step_id,
      failure: {
        status: "failed",
        step_id: result.step_id,
        failure: {
          step_id: result.step_id,
          stage: "validation",
          component: `kernel/verify:${envelope.worker}`,
          message: `Verifier threw error: ${(err as Error).message}`,
          retryable: true,
        }
      } as any
    };
  }

  return result;
}
