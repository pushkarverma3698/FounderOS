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
  verify(output: unknown, envelope: TaskEnvelope, result?: StepResult): Promise<{ ok: boolean; error?: string }>;
}

const TEMPLATE_PLACEHOLDER_REGEX = /\{\{[\w\s_-]+\}\}|\[\s*[A-Z][a-z]+(\s+[A-Z][a-z]+)*\s*\]/;

/** Keywords in an objective that signal the founder expects a file deliverable. */
const FILE_DELIVERY_KEYWORDS = /\b(csv|spreadsheet|export|file|attachment|download)\b/i;

/** No artifact at all — nothing was written and nothing was sent. */
const NO_ARTIFACT_ERROR =
  "Objective requested a file deliverable (CSV/export/spreadsheet) but no artifact was " +
  "written or delivered. Use write_artifact to create the file, then deliver_artifact to " +
  "send it. Do NOT paste data inline.";

/** File exists on disk but never reached the founder. Names the missing step precisely. */
const NOT_DELIVERED_ERROR =
  "Objective requested a file deliverable (CSV/export/spreadsheet) but there is no successful " +
  "deliver_artifact receipt. write_artifact only writes the file to disk — you MUST then call " +
  "deliver_artifact with that path to send it as a Telegram attachment. A filesystem path in " +
  "your reply is NOT delivery, and inline data is NOT delivery.";

/**
 * Phase 4 deliverable-aware verification.
 * If the step objective mentions a file/csv/export, the tool_receipts must prove it.
 * Prevents the agent from pasting raw data inline and claiming "Mission complete".
 *
 * `requireDelivery` (jobhunt) demands a deliver_artifact receipt: a founder asking for
 * a CSV wants the attachment, not a path on the VPS. Admin stays lenient because its
 * own prompt routes "save / write up / keep this as a doc" to write_artifact alone.
 */
function verifyDeliverableIfRequested(
  output: unknown,
  envelope: TaskEnvelope,
  result?: StepResult,
  requireDelivery = false,
): { ok: boolean; error?: string } {
  if (!FILE_DELIVERY_KEYWORDS.test(envelope.objective)) return { ok: true };

  // Receipts are ground truth — recorded BY CODE at the call site (kernel/worker.ts),
  // so the model cannot write one. Whenever the receipts channel exists (always, on the
  // real path: worker.ts populates tool_receipts for every step) it is the ONLY evidence
  // that counts. The model's own prose must never rescue a missing delivery: the jobhunt
  // prompt orders the worker to say "deliver_artifact", which makes those words the
  // cheapest token it can emit and worthless as proof.
  if (result && "tool_receipts" in result && Array.isArray(result.tool_receipts)) {
    const receipts = result.tool_receipts;
    const hasDeliver = receipts.some((r) => r.tool === "deliver_artifact" && r.ok);
    if (hasDeliver) return { ok: true };
    const hasWrite = receipts.some((r) => r.tool === "write_artifact" && r.ok);
    if (!hasWrite) return { ok: false, error: NO_ARTIFACT_ERROR };
    // Written but not sent — the retry has to name the ONE missing call, or the
    // model re-writes the file it already has instead of delivering it.
    return requireDelivery ? { ok: false, error: NOT_DELIVERED_ERROR } : { ok: true };
  }

  // No receipts channel at all (callers outside the worker path): text is all there is.
  const text = typeof output === "object" && output !== null ? JSON.stringify(output) : String(output);
  if (!/deliver_artifact/i.test(text)) {
    return { ok: false, error: requireDelivery ? NOT_DELIVERED_ERROR : NO_ARTIFACT_ERROR };
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
    async verify(output, envelope, result) {
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
      const deliverableCheck = verifyDeliverableIfRequested(output, envelope, result);
      if (!deliverableCheck.ok) return deliverableCheck;
      return { ok: true };
    },
  },

  jobhunt: {
    async verify(output, envelope, result) {
      if (typeof output === "object" && output !== null) {
        const obj = output as Record<string, unknown>;
        if ("rows" in obj && Array.isArray(obj.rows) && !("count" in obj)) {
          return { ok: false, error: "Job state result missing explicit count field." };
        }
      }
      // Phase 4 + P7-B: a founder asking for a CSV wants the attachment, so jobhunt
      // requires a deliver_artifact receipt — write_artifact alone is not delivery.
      const deliverableCheck = verifyDeliverableIfRequested(output, envelope, result, true);
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
    const check = await verifier.verify(result.output, envelope, result);
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
