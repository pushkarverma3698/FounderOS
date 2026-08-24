/**
 * FounderOS — submit_application
 * ================================
 * The ONE gated tool in the easy-apply flow. `/apply N` (gateway command) does
 * everything up to and including showing the founder a screenshot of the
 * filled form — that is informational, the same trust class as
 * `deliver_artifact` sending him a PDF. This tool is the one thing after it: an
 * actual submission to a third party, and ADR-018 says the machine never does
 * that unattended.
 *
 * CODE BEFORE `hitlGate()` RUNS TWICE — once to raise the interrupt, once on
 * resume after approval (see `src/infra/hitl.ts`'s own header comment). That
 * is why the re-fill happens BEFORE the gate: filling a form with the same
 * values twice is idempotent, exactly like `send_email`'s pre-gate dedup and
 * brand-quality checks in comms.ts. The one thing after the gate — clicking
 * submit — is NOT safe to repeat, so it is the only thing after it.
 *
 * A resolved job id is required, not a brief rank. `/apply N` resolves the row
 * once; the id is what survives the HITL wait (minutes to `HITL_TTL_MS`=24h),
 * during which the brief can re-rank. Re-resolving by rank at submit time
 * could submit the wrong company's application — see `getApplicationById`'s
 * own comment in job-queries.ts.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { getApplicationById, updateApplicationStage } from "../../db/job-queries.js";
import { writeAuditEntry } from "../../db/queries.js";
import { readApplyProfile } from "../../tools/jobhunt/apply-profile.js";
import { previewApplyFlow, submitApplyFlow } from "../../tools/jobhunt/apply-headless.js";
import { childLogger } from "../../infra/logger.js";
import { idemKey, hitlGate } from "./hitl.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tool:submit-application" });

export const submitApplication = tool(
  async ({ job_id }, config) => {
    const row = await getApplicationById(job_id);
    if (!row) return `No application row with id ${job_id} — nothing to submit.`;
    if (row.stage === "applied") return `${row.company} — ${row.title} is already marked applied. Not re-submitted.`;
    if (!row.url) return `${row.company} — ${row.title} has no application URL on file. Cannot submit.`;

    const profileRead = await readApplyProfile();
    if (!profileRead.ok) {
      return `Cannot submit — no usable apply profile: ${profileRead.reason}. Run /profile to fix it.`;
    }

    // Idempotent to repeat on interrupt() replay: fills the form again with the
    // same values, sends nothing, submits nothing. MUST be the preview flow, not
    // submitApplyFlow — the latter clicks the real Submit button, and this call
    // runs before hitlGate() below has resolved anything.
    const filled = await previewFlowSafely(row.url, profileRead.profile, row.id);
    if (!filled.ok) {
      return `Could not prepare the form for ${row.company}: ${filled.reason}`;
    }

    const unansweredNote =
      filled.result.unansweredQuestions.length > 0
        ? `\n\nLeft blank: ${filled.result.unansweredQuestions.slice(0, 5).join("; ")}${filled.result.unansweredQuestions.length > 5 ? `, +${filled.result.unansweredQuestions.length - 5} more` : ""}`
        : "";

    const rejected = await hitlGate(
      {
        action: "submit_application",
        title: `📮 Submit application — ${row.company} — ${row.title}?`,
        summary:
          `Form refilled and ready (${filled.result.summary.filled}/${filled.result.summary.total} fields). ` +
          `This clicks the real Submit button on ${row.url}.${unansweredNote}`,
        preview: `${row.company} — ${row.title}\n${row.url}`,
        args: { job_id, company: row.company, title: row.title, url: row.url },
      },
      config,
    );
    if (rejected) return `Not submitted — ${row.company} stays in the queue. ${rejected}`;

    // AFTER THE GATE, ONCE: the actual click. Re-navigates and re-fills one
    // more time rather than trying to keep the earlier browser session alive
    // across the wait — no live process survives a resume that can arrive
    // hours later.
    const submitted = await submitApplyFlowSafely(row.url, profileRead.profile, row.id);
    if (!submitted.ok) {
      return `Approved, but the submit attempt failed: ${submitted.reason}. Nothing was recorded as applied — try /apply ${row.brief_rank ?? "N"} again.`;
    }

    const { outcome } = submitted.result;
    if (!outcome.clicked) {
      return `Approved, but no submit button was found on ${row.company}'s form. Nothing was recorded as applied — open the link and submit it yourself, then send /applied ${row.brief_rank ?? "N"}.`;
    }

    await writeAuditEntry({
      tenant_id: TENANT,
      action: "submit_application",
      idempotency_key: idemKey("submit_application", row.id),
      payload: { job_id: row.id, company: row.company, title: row.title, url: row.url, confirmed: outcome.confirmed, evidence: outcome.evidence },
    });

    if (!outcome.confirmed) {
      // CLICKED BUT NOT CONFIRMED — never claim success without a signal
      // (rule #24). Deliberately does NOT move the row to 'applied': an
      // unconfirmed submit is a state the founder needs to check, not one the
      // pipeline has decided on his behalf.
      return (
        `Clicked Submit for ${row.company} — ${row.title}, but could not confirm it went through ` +
        `(${outcome.evidence}). Please check the tab yourself. If it worked, send /applied ${row.brief_rank ?? "N"} to clear it.`
      );
    }

    await updateApplicationStage(row.id, "applied", { appliedAt: new Date(), clearBriefRank: true });
    log.info({ id: row.id, company: row.company }, "Application submitted and confirmed");
    return `✅ Submitted — ${row.company} — ${row.title}. Confirmed: ${outcome.evidence}`;
  },
  {
    name: "submit_application",
    description:
      "Submit a job application by clicking the real Submit button on the employer's form. The founder is asked to APPROVE before it submits (this is required, ADR-018). Provide the job_id from an /apply N preview.",
    schema: z.object({
      job_id: z.string().uuid().describe("The job_applications.id resolved by a prior /apply N call"),
    }),
  },
);

/** Pre-gate pass: fills the form, never clicks submit. Safe to repeat on interrupt() replay. */
async function previewFlowSafely(
  url: string,
  profile: Parameters<typeof previewApplyFlow>[1],
  jobId: string,
): Promise<{ ok: true; result: Awaited<ReturnType<typeof previewApplyFlow>> & { ok: true } } | { ok: false; reason: string }> {
  try {
    const result = await previewApplyFlow(url, profile, {});
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, result };
  } catch (err) {
    log.error({ jobId, err: (err as Error).message }, "previewApplyFlow threw");
    return { ok: false, reason: (err as Error).message };
  }
}

async function submitApplyFlowSafely(
  url: string,
  profile: Parameters<typeof submitApplyFlow>[1],
  jobId: string,
): Promise<{ ok: true; result: Awaited<ReturnType<typeof submitApplyFlow>> & { ok: true } } | { ok: false; reason: string }> {
  try {
    const result = await submitApplyFlow(url, profile, {});
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true, result };
  } catch (err) {
    log.error({ jobId, err: (err as Error).message }, "submitApplyFlow threw");
    return { ok: false, reason: (err as Error).message };
  }
}
