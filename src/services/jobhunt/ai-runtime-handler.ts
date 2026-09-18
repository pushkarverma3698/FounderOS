import { type BrowserApplicationExecutor, BrowserException } from "./browser-executor.js";
import { type ApplicationPacket } from "../../tools/jobhunt/apply-packet.js";
import { childLogger } from "../../infra/logger.js";
import { db } from "../../db/client.js";
import { hitlApprovals } from "../../db/schema.js";

const log = childLogger({ module: "jobhunt:ai-runtime-handler" });

/**
 * Handles exceptions thrown during deterministic browser execution.
 * 
 * If the deterministic executor fails (e.g. unknown ATS, missing fields, or validation errors),
 * we attempt to recover using an AI Runtime (Antigravity).
 * 
 * @returns boolean True if recovered and execution can proceed, false if failed/blocked permanently.
 */
export async function handleBrowserException(
  executor: BrowserApplicationExecutor,
  packet: ApplicationPacket,
  error: any
): Promise<boolean> {
  const context = error instanceof BrowserException ? error.context : {};
  log.warn({ jobId: packet.row.id, error: error.message, context }, "Escalating browser exception to AI Runtime");

  // In a full implementation, we would invoke the Antigravity agent SDK here:
  // e.g. `const agent = new AntigravityAgent(); await agent.run(...)`
  // and give it access to `executor.page` to analyze the DOM, click buttons,
  // or return new field mappings to the deterministic executor.

  // For now, if we cannot deterministically recover, we escalate to FounderOS (HITL)
  // to ensure we don't hallucinate form fields or stall indefinitely.
  try {
    await escalateToFounder(packet.row.id, packet.row.company, error.message);
    log.info("Escalated to FounderOS HITL successfully.");
    return true; // We "recovered" by deferring to a human response later.
  } catch (escalateErr) {
    log.error({ escalateErr }, "Failed to escalate to FounderOS");
    return false;
  }
}

async function escalateToFounder(jobId: string, company: string, reason: string) {
  // Create a HITL Approval request for the founder to review the broken application
  await db.insert(hitlApprovals).values({
    thread_id: `jobhunt:operator:${jobId}`,
    tenant_id: "turicks",
    status: "pending",
    callback_data: JSON.stringify({ action: "resume_application", jobId }),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    rejection_reason: `Automation failed for ${company}: ${reason}`
  });
}
