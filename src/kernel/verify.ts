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

/** Keywords in an objective that signal the founder expects a file deliverable. */
const FILE_DELIVERY_KEYWORDS = /\b(csv|spreadsheet|export|file|attachment|download)\b/i;

/**
 * Phase 4 deliverable-aware verification.
 * If the step objective mentions a file/csv/export, the tool_receipts MUST include
 * write_artifact (file created) and deliver_artifact (file sent to Telegram).
 * Prevents the agent from pasting raw data inline and claiming "Mission complete".
 */
function verifyDeliverableIfRequested(
  output: unknown,
  envelope: TaskEnvelope,
): { ok: boolean; error?: string } {
  if (!FILE_DELIVERY_KEYWORDS.test(envelope.objective)) return { ok: true };

  // Extract tool receipts from the step result (the output object is the parsed
  // model output, but we need the receipts from the enclosing StepResult —
  // however, the verifier only receives `output` and `envelope`. The receipts
  // live on the StepResult *wrapping* this output. We check the serialised
  // output for evidence of artifact tool calls as a heuristic, since the
  // verifier interface doesn't expose receipts directly.)
  const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);

  // If the output itself mentions an artifact path or a delivered file, the
  // tools were called — accept it.
  const hasArtifactEvidence =
    /artifact_?root|write_artifact|deliver_artifact/i.test(text) ||
    /\.csv|\.json|\.txt|\.md/i.test(text) && /deliver|attach|sent.*file/i.test(text);

  if (!hasArtifactEvidence) {
    return {
      ok: false,
      error:
        "Objective requested a file deliverable (CSV/export/spreadsheet) but no artifact was " +
        "written or delivered. Use write_artifact to create the file, then deliver_artifact to " +
        "send it. Do NOT paste data inline.",
    };
  }

  return { ok: true };
}

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
    async verify(output, envelope) {
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
      // Phase 4: deliverable-aware check — if the objective asks for a file, receipts must prove it
      const deliverableCheck = verifyDeliverableIfRequested(output, envelope);
      if (!deliverableCheck.ok) return deliverableCheck;
      return { ok: true };
    },
  },

  jobhunt: {
    async verify(output, envelope) {
      if (typeof output === "object" && output !== null) {
        const obj = output as Record<string, unknown>;
        if ("rows" in obj && Array.isArray(obj.rows) && !("count" in obj)) {
          return { ok: false, error: "Job state result missing explicit count field." };
        }
      }
      // Phase 4: deliverable-aware check — if the objective asks for a file, receipts must prove it
      const deliverableCheck = verifyDeliverableIfRequested(output, envelope);
      if (!deliverableCheck.ok) return deliverableCheck;
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
