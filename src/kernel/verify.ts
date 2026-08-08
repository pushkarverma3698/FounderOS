/**
 * FounderOS v3 kernel — verification node.
 * ==========================================
 * Pure code node to verify worker outputs against semantic or functional requirements
 * before they are committed to the results channel.
 * Populated for all 8 workers per 09-VERIFICATION-RECOVERY.md (Phase 4).
 */

import { existsSync, statSync } from "node:fs";
import type { StepResult, TaskEnvelope } from "./contracts.js";

export interface StepVerifier {
  verify(output: unknown, envelope: TaskEnvelope): Promise<{ ok: boolean; error?: string }>;
}

const TEMPLATE_PLACEHOLDER_REGEX = /\{\{[\w\s_-]+\}\}|\[\s*[A-Z][a-z]+(\s+[A-Z][a-z]+)*\s*\]/;

export const VERIFIERS: Record<string, StepVerifier> = {
  /** comms verifier: check that email and other communication drafts do not leak raw placeholders or templates */
  comms: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      if (TEMPLATE_PLACEHOLDER_REGEX.test(text)) {
        return { ok: false, error: "Output draft contains unresolved template placeholders." };
      }
      return { ok: true };
    },
  },

  marketing: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      if (TEMPLATE_PLACEHOLDER_REGEX.test(text)) {
        return { ok: false, error: "Marketing draft contains unresolved template placeholders." };
      }
      return { ok: true };
    },
  },

  sales: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      if (TEMPLATE_PLACEHOLDER_REGEX.test(text)) {
        return { ok: false, error: "Sales draft contains unresolved template placeholders." };
      }
      return { ok: true };
    },
  },

  admin: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      const match = /path["']?\s*:\s*["']([^"']+)["']/.exec(text) || /written successfully to ([^\s]+)/.exec(text);
      if (match && match[1]) {
        const filePath = match[1];
        if (!existsSync(filePath)) {
          return { ok: false, error: `Admin artifact path does not exist on disk: ${filePath}` };
        }
        const stats = statSync(filePath);
        if (stats.size === 0) {
          return { ok: false, error: `Admin artifact path is 0 bytes: ${filePath}` };
        }
      }
      return { ok: true };
    },
  },

  jobhunt: {
    async verify(output) {
      if (typeof output === "object" && output !== null) {
        const obj = output as Record<string, unknown>;
        if ("rows" in obj && Array.isArray(obj.rows) && !("count" in obj)) {
          return { ok: false, error: "Job state result missing explicit count field." };
        }
      }
      return { ok: true };
    },
  },

  engineering: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      if (text.includes("Command failed with exit code") || text.includes("command failed:")) {
        return { ok: false, error: "Engineering step reported command failure." };
      }
      return { ok: true };
    },
  },

  research: {
    async verify(output) {
      if (typeof output === "object" && output !== null) {
        const obj = output as Record<string, unknown>;
        if ("summary" in obj && typeof obj.summary === "string" && obj.summary.length > 50) {
          if ("sources" in obj && Array.isArray(obj.sources) && obj.sources.length === 0) {
            return { ok: false, error: "Research summary provides claims but zero source URLs." };
          }
        }
      }
      return { ok: true };
    },
  },

  personal: {
    async verify(output) {
      const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
      if (text.includes("0 bytes")) {
        return { ok: false, error: "Personal file operation reported 0 bytes." };
      }
      return { ok: true };
    },
  },
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
        },
      };
    }
  } catch (err) {
    return {
      status: "failed",
      step_id: result.step_id,
      failure: {
        step_id: result.step_id,
        stage: "validation",
        component: `kernel/verify:${envelope.worker}`,
        message: `Verifier threw error: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }

  return result;
}
